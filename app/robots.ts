import type { MetadataRoute } from "next";

// Crawlers may index the static page. The API only accepts POST and rejects
// bots anyway, but we ask politely too.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }],
  };
}
