export type GitHubImportQuery =
  | {
      scope: "organization";
      organization: string;
      role?: "all" | "admin" | "member";
    }
  | {
      scope: "team";
      organization: string;
      team: string;
      role?: "all" | "maintainer" | "member";
    }
  | {
      scope: "repository";
      organization: string;
      repository: string;
      permission?: "maintain" | "admin";
    };

export type GitHubImportMember = {
  id: number;
  login: string;
  avatarUrl?: string;
  htmlUrl?: string;
  role?: string;
};

export type GitHubImportPreview = {
  source: GitHubImportQuery;
  members: GitHubImportMember[];
  truncated: boolean;
};

export type GitHubMemberSource = {
  preview(query: GitHubImportQuery): Promise<GitHubImportPreview>;
};

export class GitHubRestMemberSource implements GitHubMemberSource {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #maxMembers: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    baseUrl?: string;
    token: string;
    maxMembers?: number;
    fetch?: typeof globalThis.fetch;
  }) {
    const url = new URL(options.baseUrl ?? "https://api.github.com");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new Error("GitHub API URL must use HTTPS or loopback HTTP");
    }
    if (url.search || url.hash) throw new Error("GitHub API URL must not contain query or fragment");
    if (!options.token.trim()) throw new Error("GitHub import token is required");
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#token = options.token;
    this.#maxMembers = Math.min(500, Math.max(1, options.maxMembers ?? 500));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async preview(rawQuery: GitHubImportQuery): Promise<GitHubImportPreview> {
    const query = normalizeQuery(rawQuery);
    const path = queryPath(query);
    const members: GitHubImportMember[] = [];
    const seen = new Set<number>();
    let page = 1;
    const pageLimit = Math.ceil(this.#maxMembers / 100);
    let truncated = false;
    while (members.length < this.#maxMembers) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.#fetch(`${this.#baseUrl}${path}${separator}per_page=100&page=${page}`, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "x-github-api-version": "2026-03-10",
          "user-agent": "crabhelm-openclaw-control-plane",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(`GitHub member discovery failed: HTTP ${response.status} ${safeMessage(payload)}`);
      }
      if (!Array.isArray(payload)) throw new Error("GitHub member discovery returned invalid JSON");
      for (const value of payload) {
        const member = normalizeMember(value, query);
        if (!member || seen.has(member.id)) continue;
        seen.add(member.id);
        members.push(member);
        if (members.length === this.#maxMembers) {
          truncated = payload.length === 100;
          break;
        }
      }
      if (payload.length < 100) break;
      if (members.length >= this.#maxMembers || page >= pageLimit) {
        truncated = true;
        break;
      }
      page += 1;
    }
    return {
      source: query,
      members: members.sort((a, b) => a.login.localeCompare(b.login)),
      truncated,
    };
  }
}

function normalizeQuery(value: GitHubImportQuery): GitHubImportQuery {
  const input = asRecord(value);
  const organization = requireSlug(input.organization, "organization");
  if (input.scope === "organization") {
    const role = input.role ?? "all";
    if (role !== "all" && role !== "admin" && role !== "member") {
      throw new Error("organization role must be all, admin, or member");
    }
    return { scope: "organization", organization, role };
  }
  if (input.scope === "team") {
    const role = input.role ?? "all";
    if (role !== "all" && role !== "maintainer" && role !== "member") {
      throw new Error("team role must be all, maintainer, or member");
    }
    return {
      scope: "team",
      organization,
      team: requireSlug(input.team, "team"),
      role,
    };
  }
  if (input.scope === "repository") {
    const permission = input.permission ?? "maintain";
    if (permission !== "maintain" && permission !== "admin") {
      throw new Error("repository permission must be maintain or admin");
    }
    return {
      scope: "repository",
      organization,
      repository: requireSlug(input.repository, "repository"),
      permission,
    };
  }
  throw new Error("GitHub import scope must be organization, team, or repository");
}

function queryPath(query: GitHubImportQuery): string {
  const org = encodeURIComponent(query.organization);
  if (query.scope === "organization") {
    return `/orgs/${org}/members?filter=all&role=${encodeURIComponent(query.role ?? "all")}`;
  }
  if (query.scope === "team") {
    return `/orgs/${org}/teams/${encodeURIComponent(query.team)}/members?role=${encodeURIComponent(query.role ?? "all")}`;
  }
  return `/repos/${org}/${encodeURIComponent(query.repository)}/collaborators?affiliation=all`;
}

function normalizeMember(value: unknown, query: GitHubImportQuery): GitHubImportMember | undefined {
  const member = asRecord(value);
  if (member.type !== undefined && member.type !== "User") return undefined;
  const id = member.id;
  const login = member.login;
  if (!Number.isSafeInteger(id) || Number(id) <= 0 || typeof login !== "string") return undefined;
  const cleanLogin = login.trim().toLowerCase();
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/.test(cleanLogin)) return undefined;
  let role: string | undefined;
  if (query.scope === "repository") {
    const permissions = asRecord(member.permissions);
    const roleName = typeof member.role_name === "string" ? member.role_name.toLowerCase() : "";
    const admin = permissions.admin === true || roleName === "admin";
    const maintain = permissions.maintain === true || roleName === "maintain";
    if (query.permission === "admin" ? !admin : !admin && !maintain) return undefined;
    role = admin ? "admin" : "maintain";
  }
  return {
    id: Number(id),
    login: cleanLogin,
    ...(typeof member.avatar_url === "string" ? { avatarUrl: member.avatar_url.slice(0, 500) } : {}),
    ...(typeof member.html_url === "string" ? { htmlUrl: member.html_url.slice(0, 500) } : {}),
    ...(role ? { role } : {}),
  };
}

function requireSlug(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const clean = value.trim().toLowerCase();
  if (!/^[a-z\d](?:[a-z\d_.-]{0,98}[a-z\d])?$/.test(clean)) {
    throw new Error(`${label} is invalid`);
  }
  return clean;
}

async function readJson(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 256_000);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function safeMessage(value: unknown): string {
  const message = asRecord(value).message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : "request failed";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
