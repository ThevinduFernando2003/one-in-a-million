import { describe, expect, it } from "vitest";
import {
  clientIp,
  isAllowedFetchSite,
  isAllowedOrigin,
  isBotUserAgent,
  parseAllowList,
} from "@/lib/guards";
import {
  isValidVisitorId,
  newVisitorId,
  visitorCookieOptions,
  VISITOR_COOKIE_MAX_AGE,
} from "@/lib/identity";

const BROWSERS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  // Phone model containing "BOT" must not be treated as a bot.
  "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  // In-app browsers of real humans.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]",
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 Telegram-Android/10.0",
];

const BOTS = [
  "",
  "WhatsApp/2.23.20.0 A",
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "TelegramBot (like TwitterBot)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  "curl/8.4.0",
  "python-requests/2.31.0",
  "Go-http-client/1.1",
  "node",
  "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
];

describe("isBotUserAgent", () => {
  it.each(BROWSERS)("allows a real browser: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });
  it.each(BOTS)("rejects bot / preview / library: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });
  it("rejects missing UA", () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("accepts the deployment's own origin", () => {
    expect(isAllowedOrigin({ origin: "https://oiam.app", host: "oiam.app" })).toBe(true);
    expect(isAllowedOrigin({ origin: "http://localhost:3000", host: "localhost:3000" })).toBe(true);
  });
  it("prefers X-Forwarded-Host and checks the forwarded scheme", () => {
    expect(
      isAllowedOrigin({
        origin: "https://oiam.app",
        host: "internal:8080",
        forwardedHost: "oiam.app",
        forwardedProto: "https",
      }),
    ).toBe(true);
    expect(
      isAllowedOrigin({ origin: "http://oiam.app", host: "oiam.app", forwardedProto: "https" }),
    ).toBe(false);
  });
  it("rejects missing, null, foreign or malformed origins", () => {
    expect(isAllowedOrigin({ origin: null, host: "oiam.app" })).toBe(false);
    expect(isAllowedOrigin({ origin: "null", host: "oiam.app" })).toBe(false);
    expect(isAllowedOrigin({ origin: "https://evil.example", host: "oiam.app" })).toBe(false);
    expect(isAllowedOrigin({ origin: "https://oiam.app.evil.example", host: "oiam.app" })).toBe(
      false,
    );
    expect(isAllowedOrigin({ origin: "not a url", host: "oiam.app" })).toBe(false);
    expect(isAllowedOrigin({ origin: "ftp://oiam.app", host: "oiam.app" })).toBe(false);
    expect(isAllowedOrigin({ origin: "https://oiam.app", host: null })).toBe(false);
  });
  it("honours the allow-list", () => {
    expect(
      isAllowedOrigin({
        origin: "https://preview.example",
        host: "oiam.app",
        allowList: parseAllowList(" https://preview.example/ , https://x.example"),
      }),
    ).toBe(true);
  });
});

describe("fetch metadata and IP", () => {
  it("allows only same-origin Sec-Fetch-Site (or none)", () => {
    expect(isAllowedFetchSite(null)).toBe(true);
    expect(isAllowedFetchSite("same-origin")).toBe(true);
    expect(isAllowedFetchSite("cross-site")).toBe(false);
    expect(isAllowedFetchSite("same-site")).toBe(false);
  });
  it("extracts the first forwarded IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("visitor identity", () => {
  it("mints valid v4 UUIDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, newVisitorId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isValidVisitorId(id)).toBe(true);
  });
  it("rejects anything that is not a v4 UUID", () => {
    for (const bad of [
      "",
      "123",
      "00000000-0000-0000-0000-000000000000",
      "A".repeat(36),
      null,
      5,
      "{oiam}:counter",
    ]) {
      expect(isValidVisitorId(bad)).toBe(false);
    }
  });
  it("uses httpOnly, Secure, SameSite=Lax, 1 year", () => {
    const o = visitorCookieOptions("https://oiam.app/api/token");
    expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(o.maxAge).toBe(VISITOR_COOKIE_MAX_AGE);
    expect(VISITOR_COOKIE_MAX_AGE).toBe(31_536_000);
  });
  it("drops Secure only for plain-http loopback (local dev)", () => {
    expect(visitorCookieOptions("http://localhost:3000/").secure).toBe(false);
    expect(visitorCookieOptions("http://127.0.0.1:3000/").secure).toBe(false);
    expect(visitorCookieOptions("http://oiam.app/").secure).toBe(true);
    expect(visitorCookieOptions("garbage").secure).toBe(true);
  });
});
