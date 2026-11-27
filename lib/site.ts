/**
 * Canonical site URL for metadata, the sitemap and structured data. It is
 * read on the server at build time, never shipped as a client env var.
 *
 * Order: SITE_URL (set this once you add a custom domain) → Vercel's
 * production URL → localhost.
 */
export function siteUrl(): URL {
  const explicit = process.env.SITE_URL;
  if (explicit) {
    try {
      return new URL(explicit);
    } catch {
      /* fall through */
    }
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return new URL(`https://${vercel}`);
  return new URL("http://localhost:3000");
}

export const SITE_NAME = "One in a Million";
export const SITE_DESCRIPTION =
  "Take a number! Every visitor gets a unique number, handed out in order, until all one million are taken. What's yours?";
