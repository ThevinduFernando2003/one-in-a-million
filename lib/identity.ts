/**
 * Visitor identity: an opaque random UUID in an httpOnly cookie.
 *
 * The browser never sees or sends a token number. It only carries this id,
 * and the server decides what number the id holds. Without the id nobody can
 * claim someone else's number, and a forged or random id is just a new
 * visitor (the same as an incognito window).
 */

export const VISITOR_COOKIE = "oiam_vid";
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, in seconds

// RFC 4122 v4 UUID, as produced by crypto.randomUUID().
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidVisitorId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function newVisitorId(): string {
  return crypto.randomUUID();
}

/**
 * Cookie attributes. The cookie is always Secure, except over plain http to a
 * loopback host, where Safari would otherwise drop it during local
 * development. In production on Vercel the request is always https.
 */
export function visitorCookieOptions(requestUrl: string) {
  let secure = true;
  try {
    const u = new URL(requestUrl);
    const loopback =
      u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol === "http:" && loopback) secure = false;
  } catch {
    // Keep secure = true.
  }
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: VISITOR_COOKIE_MAX_AGE,
  };
}
