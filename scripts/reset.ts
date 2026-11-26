/**
 * Reset the token counter for launch.
 *
 *   RESET_CONFIRM=yes npm run reset                 # counter → 0 (next visitor gets 1)
 *   RESET_CONFIRM=yes npm run reset -- --to 999998  # seed (e.g. to rehearse sold-out)
 *   NODE_ENV=production RESET_CONFIRM=yes npm run reset -- --force
 *
 * Safety:
 *  - Refuses unless RESET_CONFIRM=yes.
 *  - Refuses when NODE_ENV=production unless --force is passed.
 *  - Sets the counter and clears the last owner atomically (MULTI/EXEC).
 */
import { HARD_LIMIT } from "@/lib/config";
import { createRedis, resolveRedisCredentials } from "@/lib/redis";
import { loadLocalEnv, readCounter, setCounter } from "./ops";

function parseArgs(argv: string[]) {
  const force = argv.includes("--force");
  let to = 0;
  const i = argv.indexOf("--to");
  if (i !== -1) {
    const raw = argv[i + 1];
    if (!raw || !/^\d+$/.test(raw)) throw new Error("--to needs a non-negative integer");
    to = Number(raw);
    if (to > HARD_LIMIT) throw new Error(`--to must be <= ${HARD_LIMIT}`);
  }
  return { force, to };
}

async function main() {
  loadLocalEnv();
  const { force, to } = parseArgs(process.argv.slice(2));

  if (process.env.RESET_CONFIRM !== "yes") {
    console.error("Refusing to reset: set RESET_CONFIRM=yes to confirm.");
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production" && !force) {
    console.error(
      "Refusing to reset with NODE_ENV=production. Pass --force if you really mean it.",
    );
    process.exit(3);
  }

  const creds = resolveRedisCredentials();
  const redis = createRedis(creds);
  const host = new URL(creds.url).host;
  const before = await readCounter(redis);
  await setCounter(redis, to);
  const after = await readCounter(redis);
  console.log(
    `Redis ${host}: counter ${before} → ${after}. Next visitor gets ${after + 1 <= HARD_LIMIT ? after + 1 : "nothing (sold out)"}.`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
