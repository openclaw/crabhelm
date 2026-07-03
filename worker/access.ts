import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccessIdentity = {
  subject: string;
  email: string;
  roles: Array<"administrator" | "member">;
  groups: string[];
};

type AccessClaims = {
  sub?: string;
  email?: string;
  groups?: unknown;
};

export async function verifyAccessIdentity(request: Request, env: Env): Promise<AccessIdentity | undefined> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.CF_ACCESS_TEAM_DOMAIN?.trim() || !env.CF_ACCESS_AUD?.trim()) return undefined;
  const issuer = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: env.CF_ACCESS_AUD.trim(),
    algorithms: ["RS256"],
  });
  const claims = payload as AccessClaims;
  const email = claims.email?.trim().toLowerCase();
  const subject = claims.sub?.trim();
  if (!email || !subject || email.length > 320 || subject.length > 200) throw new Error("Cloudflare Access identity is incomplete");
  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 100)
    : [];
  const adminEmails = csv(env.CF_ACCESS_ADMIN_EMAILS).map((value) => value.toLowerCase());
  const adminGroups = csv(env.CF_ACCESS_ADMIN_GROUPS);
  const administrator = adminEmails.includes(email) || groups.some((group) => adminGroups.includes(group));
  return {
    subject: `email:${email}`,
    email,
    roles: administrator ? ["administrator", "member"] : ["member"],
    groups,
  };
}

function normalizeTeamDomain(value: string): string {
  const input = value.trim().replace(/\/$/u, "");
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com") || url.pathname !== "/") {
    throw new Error("Cloudflare Access team domain is invalid");
  }
  return url.origin;
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}
