import {
  decodeProtectedHeader,
  importSPKI,
  jwtVerify,
} from "jose";
import type { AccessIdentity } from "../worker/access.js";

type ImportedSpkiKey = Awaited<ReturnType<typeof importSPKI>>;

type AlbHeader = {
  alg?: unknown;
  kid?: unknown;
  signer?: unknown;
  client?: unknown;
  iss?: unknown;
  exp?: unknown;
};

export type AlbIdentityVerifierOptions = {
  region: string;
  loadBalancerArn: string;
  oidcIssuer: string;
  oidcClientId: string;
  adminEmails: string[];
  adminGroups: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

export function createAlbIdentityVerifier(options: AlbIdentityVerifierOptions) {
  const expected = validateOptions(options);
  const keys = new Map<string, { key: ImportedSpkiKey; expiresAt: number }>();
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  return async (request: Request): Promise<AccessIdentity | undefined> => {
    const token = request.headers.get("x-amzn-oidc-data")?.trim();
    if (!token) return undefined;
    if (token.length > 24 * 1024) throw new Error("ALB identity assertion is too large");

    const header = decodeProtectedHeader(token) as AlbHeader;
    const kid = textHeader(header.kid, "key id");
    if (!/^[A-Za-z0-9-]{1,200}$/u.test(kid)) throw new Error("ALB identity key id is invalid");
    if (header.alg !== "ES256") throw new Error("ALB identity algorithm is invalid");
    if (header.signer !== expected.loadBalancerArn) throw new Error("ALB identity signer is invalid");
    if (header.client !== expected.oidcClientId) throw new Error("ALB identity client is invalid");
    if (header.iss !== expected.oidcIssuer) throw new Error("ALB identity issuer is invalid");
    const expiresAt = expiration(header.exp);
    const nowSeconds = Math.floor(now() / 1000);
    if (expiresAt <= nowSeconds) throw new Error("ALB identity assertion expired");
    if (expiresAt > nowSeconds + 7 * 24 * 60 * 60) throw new Error("ALB identity expiration is invalid");

    const key = await publicKey(kid, now(), keys, expected.region, expected.partition, fetcher);
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"] });
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!subject || subject.length > 200 || !validEmail(email)) {
      throw new Error("ALB identity is incomplete");
    }
    if (!verifiedEmailClaim(payload.email_verified)) {
      throw new Error("ALB identity email is unverified");
    }
    const forwardedSubject = request.headers.get("x-amzn-oidc-identity")?.trim();
    if (forwardedSubject && forwardedSubject !== subject) {
      throw new Error("ALB identity subject mismatch");
    }
    const groups = Array.isArray(payload.groups)
      ? payload.groups
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 100)
      : [];
    const administrator = expected.adminEmails.has(email) ||
      groups.some((group) => expected.adminGroups.has(group));
    return {
      subject: `email:${email}`,
      email,
      roles: administrator ? ["administrator", "member"] : ["member"],
      groups,
    };
  };
}

function validateOptions(options: AlbIdentityVerifierOptions) {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*$/u.test(options.region)) {
    throw new Error("AWS region is invalid");
  }
  const arn = options.loadBalancerArn.match(
    new RegExp(`^arn:(aws(?:-us-gov)?):elasticloadbalancing:${escapeRegex(options.region)}:[0-9]{12}:loadbalancer/app/`),
  );
  if (!arn) {
    throw new Error("ALB ARN is invalid");
  }
  const expectedPartition = options.region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  if (arn[1] !== expectedPartition) throw new Error("ALB ARN is invalid");
  const issuer = new URL(options.oidcIssuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new Error("OIDC issuer is invalid");
  }
  if (!options.oidcClientId.trim()) throw new Error("OIDC client id is required");
  return {
    region: options.region,
    partition: arn[1]!,
    loadBalancerArn: options.loadBalancerArn,
    oidcIssuer: issuer.pathname === "/" ? issuer.origin : issuer.toString(),
    oidcClientId: options.oidcClientId.trim(),
    adminEmails: new Set(options.adminEmails.map((value) => value.toLowerCase())),
    adminGroups: new Set(options.adminGroups),
  };
}

async function publicKey(
  kid: string,
  currentTime: number,
  cache: Map<string, { key: ImportedSpkiKey; expiresAt: number }>,
  region: string,
  partition: string,
  fetcher: typeof globalThis.fetch,
): Promise<ImportedSpkiKey> {
  const cached = cache.get(kid);
  if (cached && cached.expiresAt > currentTime) return cached.key;
  const response = await fetcher(publicKeyUrl(region, partition, kid), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`ALB identity public key is unavailable (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 16 * 1024) throw new Error("ALB identity public key is too large");
  const pem = await response.text();
  if (pem.length > 16 * 1024) throw new Error("ALB identity public key is too large");
  const key = await importSPKI(pem, "ES256");
  if (cache.size >= 32) cache.delete(cache.keys().next().value as string | undefined ?? "");
  cache.set(kid, { key, expiresAt: currentTime + 60 * 60 * 1000 });
  return key;
}

function publicKeyUrl(region: string, partition: string, kid: string): string {
  if (partition === "aws-us-gov") {
    return `https://s3-${region}.amazonaws.com/aws-elb-public-keys-prod-${region}/${kid}`;
  }
  return `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`;
}

function expiration(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[0-9]+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("ALB identity expiration is invalid");
  return parsed;
}

function textHeader(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ALB identity ${label} is invalid`);
  return value.trim();
}

function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function verifiedEmailClaim(value: unknown): boolean {
  // Cognito UserInfo emits verification flags as strings. Multi-valued claims
  // are ambiguous and must not be collapsed to one apparently true value.
  return value === true || value === "true";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
