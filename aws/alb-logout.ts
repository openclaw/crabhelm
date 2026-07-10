const albCookieShardCount = 4;
const expiredCookieDate = "Thu, 01 Jan 1970 00:00:00 GMT";

export type AlbLogoutOptions = {
  consoleOrigin: string;
  sessionCookieName: string;
};

/** Handles only the two console paths forwarded by the unauthenticated ALB rule. */
export function albLogoutResponse(
  request: Request,
  options: AlbLogoutOptions,
): Response | undefined {
  const url = new URL(request.url);
  if (url.origin !== options.consoleOrigin) return undefined;
  if (url.pathname !== "/logout" && url.pathname !== "/signed-out") return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...safeHeaders(), allow: "GET, HEAD" },
    });
  }

  if (url.pathname === "/signed-out") {
    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>Signed out</title>" +
        "<h1>Signed out</h1><p>Your Crabhelm console session has ended.</p>" +
        "<p><a href=\"/\">Sign in again</a></p>",
      {
        status: 200,
        headers: { ...safeHeaders(), "content-type": "text/html; charset=utf-8" },
      },
    );
  }

  const headers = new Headers(safeHeaders());
  headers.set("location", new URL("/signed-out", options.consoleOrigin).toString());
  for (const name of albAuthenticationCookieNames(options.sessionCookieName)) {
    headers.append(
      "set-cookie",
      `${name}=; Path=/; Expires=${expiredCookieDate}; Max-Age=-1; Secure; HttpOnly; SameSite=None`,
    );
  }
  return new Response(null, { status: 303, headers });
}

function albAuthenticationCookieNames(base: string): string[] {
  return [
    base,
    ...Array.from({ length: albCookieShardCount }, (_, index) => `${base}-${index}`),
  ];
}

function safeHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store, max-age=0",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow",
  };
}
