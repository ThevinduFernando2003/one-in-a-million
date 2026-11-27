/**
 * Request guards for POST /api/token. These are pure functions over header
 * values, so they are easy to unit test.
 *
 * They are a filter, not a security boundary. Their job is to stop link
 * previewers, crawlers and scripted clients from casually burning numbers.
 * Correctness (uniqueness, ordering, ceiling) never depends on them.
 */

/**
 * Link-preview fetchers, crawlers and headless tools that pretend to be a
 * browser ("Mozilla/5.0 (compatible; Discordbot/2.0; …)"). Bare app names
 * like "LinkedIn" or "Telegram" are deliberately excluded: those also appear
 * in the UAs of real humans using in-app browsers. The bot forms
 * ("LinkedInBot/1.0", "TelegramBot") are caught by the `bot/` and `bot`
 * word rules. `\bbot` needs a word boundary, so phone models like "CUBOT"
 * stay allowed.
 */
export const BOT_UA =
  /bot\/|bot;|bot\)|\bbot\b|crawler|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp\/|skypeuripreview|embedly|vkshare|slack-imgproxy|bitlybot|quora link preview|w3c_validator|headlesschrome|phantomjs|puppeteer|playwright|google-inspectiontool|google-read-aloud|mediapartners-google|feedfetcher|bingpreview|iframely|metainspector|ccbot|gptbot|chatgpt-user|claude-web|perplexity|bytespider|petalbot|semrush|ahrefs|uptimerobot|pingdom|statuscake/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true; // Every real browser sends a User-Agent.
  const trimmed = ua.trim();
  if (trimmed.length < 10 || trimmed.length > 1024) return true;
  // Every modern browser's UA starts with this. Plain HTTP libraries (curl,
  // python-requests, Go, Node's undici …) and most preview fetchers
  // ("WhatsApp/2.23", "Twitterbot/1.0", "Slackbot-LinkExpanding") do not.
  if (!/^mozilla\/5\.0 /i.test(trimmed)) return true;
  return BOT_UA.test(trimmed);
}

/**
 * The browser always sends Origin on a cross-origin or same-origin POST made
 * with fetch(). We require it, and it must match this deployment's own origin
 * (taken from the Host / X-Forwarded-Host the platform set) or an explicit
 * allow-list entry.
 */
export function isAllowedOrigin(params: {
  origin: string | null;
  host: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  allowList?: readonly string[];
}): boolean {
  const { origin, allowList = [] } = params;
  if (!origin || origin === "null") return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== "https:" && o.protocol !== "http:") return false;
  const normalized = `${o.protocol}//${o.host}`;
  if (allowList.some((a) => a.replace(/\/+$/, "").toLowerCase() === normalized.toLowerCase())) {
    return true;
  }
  const host = (params.forwardedHost?.split(",")[0]?.trim() || params.host || "").toLowerCase();
  if (!host) return false;
  if (o.host.toLowerCase() !== host) return false;
  // If the platform told us the scheme, it has to match too.
  const proto = params.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto && `${proto}:` !== o.protocol) return false;
  return true;
}

/**
 * Fetch metadata check. If the browser sends Sec-Fetch-Site (all modern ones
 * do), only same-origin requests may allocate.
 */
export function isAllowedFetchSite(secFetchSite: string | null): boolean {
  return secFetchSite === null || secFetchSite === "same-origin";
}

/**
 * Best-effort client IP for rate limiting. On Vercel, x-forwarded-for is set
 * by the platform edge and its first entry is the client. The IP is used
 * only as a rate-limit key and is never logged.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "unknown";
}

export function parseAllowList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
