import type { Metadata, Viewport } from "next";
import { SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/site";
import { PRELOAD_SCRIPT } from "@/lib/token-client";
import "./globals.css";

const verification = process.env.GOOGLE_SITE_VERIFICATION;

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "One in a Million: take a number",
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "one in a million",
    "take a number",
    "unique number",
    "number generator",
    "online counter",
    "what number am I",
    "million visitors",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  // No live data in any preview: the OG image is static and generic.
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  // Google Search Console ownership check (HTML tag method). Set
  // GOOGLE_SITE_VERIFICATION in Vercel to the token Search Console gives you.
  ...(verification ? { verification: { google: verification } } : {}),
};

/** schema.org structured data, so search engines understand what the page is. */
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: SITE_NAME,
  url: siteUrl().toString(),
  description: SITE_DESCRIPTION,
  applicationCategory: "EntertainmentApplication",
  operatingSystem: "Any",
  browserRequirements: "Requires JavaScript",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#9a9ea6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme="neutral" is baked into the static HTML. The client switches
    // it to "dark" or "light" once the API has answered, so the wrong theme
    // never flashes.
    <html lang="en" data-theme="neutral">
      <head>
        {/* Starts the number request during HTML parsing (see lib/token-client.ts). */}
        <script dangerouslySetInnerHTML={{ __html: PRELOAD_SCRIPT }} />
        <script
          type="application/ld+json"
          // Static, build-time JSON (no user input). "<" is escaped so it can't close the tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      </head>
      <body className="min-h-dvh overflow-hidden">{children}</body>
    </html>
  );
}
