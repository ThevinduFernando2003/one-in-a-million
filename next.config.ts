import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const onVercel = process.env.VERCEL === "1";

/**
 * Content Security Policy.
 *
 * The page shell is statically prerendered (so link previews and crawlers
 * never trigger allocation), which rules out per-request nonces. Next.js
 * inlines small bootstrap scripts (`self.__next_f.push(...)`) into static
 * HTML, so `script-src` needs `'unsafe-inline'`. Everything else is locked to
 * the same origin, and the app never renders user-supplied HTML.
 * `connect-src 'self'` means the browser can only talk to our own API.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  // Only on Vercel: locally we serve plain http://localhost.
  ...(onVercel ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  ...(onVercel
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Cache Components is deliberately left off: this app needs one static page
  // and one fully dynamic POST route, and the spec requires the classic
  // `export const dynamic = 'force-dynamic'` segment config on that route
  // (which Cache Components removes).
  cacheComponents: false,
  experimental: {
    // Tailwind's CSS is small: ship it inside the HTML instead of a
    // render-blocking <link>.
    inlineCss: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
