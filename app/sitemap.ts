import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// A one-page site: the sitemap tells search engines the canonical URL.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: new URL("/", siteUrl()).toString(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
