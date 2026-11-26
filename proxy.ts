import { NextResponse, type NextRequest } from "next/server";
import {
  isValidVisitorId,
  newVisitorId,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "@/lib/identity";

/**
 * Give every page visitor an identity *before* the page's JavaScript asks
 * for a number.
 *
 * This never allocates anything: the page itself stays a static shell and
 * no Redis call happens here. A crawler or link previewer that receives this
 * cookie costs nothing.
 *
 * Why do it here instead of only in POST /api/token? If the very first
 * allocation request were the one minting the id, a timeout on that request
 * would lose the Set-Cookie, and the retry would arrive as a brand-new
 * visitor and burn a number. With the id in place beforehand, every
 * allocation attempt (including retries) carries the same id, and the
 * script's owner check makes retries idempotent.
 */
export function proxy(request: NextRequest) {
  const existing = request.cookies.get(VISITOR_COOKIE)?.value;
  if (isValidVisitorId(existing)) return NextResponse.next();

  const id = newVisitorId();
  // Forward the cookie on the incoming request too, for consistency.
  request.cookies.set(VISITOR_COOKIE, id);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(VISITOR_COOKIE, id, visitorCookieOptions(request.url));
  return response;
}

export const config = {
  // Only the page itself. Static assets, the API and metadata files are excluded.
  matcher: ["/"],
};
