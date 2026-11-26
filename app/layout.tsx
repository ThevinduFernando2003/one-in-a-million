import type { Metadata, Viewport } from "next";
import { PRELOAD_SCRIPT } from "@/lib/token-client";
import "./globals.css";

function siteUrl(): URL {
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

const description =
  "Every visitor gets a unique number, handed out in order, until all one million are taken. What's yours?";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "One in a Million",
  description,
  applicationName: "One in a Million",
  openGraph: {
    type: "website",
    title: "One in a Million",
    description,
    siteName: "One in a Million",
  },
  twitter: {
    card: "summary_large_image",
    title: "One in a Million",
    description,
  },
  // No live data in any preview: the OG image is static and generic.
  robots: { index: true, follow: true },
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
      </head>
      <body className="min-h-dvh overflow-hidden">{children}</body>
    </html>
  );
}
