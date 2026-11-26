import TokenDisplay from "@/components/TokenDisplay";

/**
 * The page is a fully static shell (prerendered at build time). It never
 * allocates. A number is requested only by client-side JavaScript after
 * hydration (POST /api/token), so link previews, crawlers and prefetches
 * cannot consume numbers.
 */
export default function Home() {
  return (
    <main className="relative isolate h-dvh w-full overflow-hidden">
      <header className="pointer-events-none absolute top-[max(1rem,env(safe-area-inset-top))] left-[max(1rem,env(safe-area-inset-left))] z-20 sm:top-6 sm:left-7">
        <h1 className="text-fg text-[0.95rem] font-semibold tracking-[-0.01em] select-none sm:text-base">
          One in a Million
        </h1>
      </header>
      <TokenDisplay />
    </main>
  );
}
