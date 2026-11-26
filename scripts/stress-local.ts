/**
 * Fully automated, local end-to-end stress test (used by `npm run verify`).
 *
 *   1. Checks that the local Redis (SRH from docker-compose) is reachable and
 *      really local. It refuses to touch any non-loopback Redis.
 *   2. Resets the counter to 0.
 *   3. Starts the production build (`next start`) on a spare port, with a
 *      raised per-IP rate limit (every request here comes from 127.0.0.1).
 *   4. Fires 50, 500 and 5,000 simultaneous POSTs with distinct cookies, then
 *      20 with the same cookie, asserting uniqueness, contiguity, order and
 *      the limit.
 *   5. Sold-out race over HTTP: seeds the counter to 999,900 and fires 500
 *      simultaneous requests. Exactly 100 must get 999,901..1,000,000, 400
 *      must be told "sold out", and nobody may receive 1,000,001.
 *   6. Stops the server and resets the counter to 0.
 *
 * Prerequisites: `npm run redis:up` and `npm run build`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createRedis, resolveRedisCredentials } from "@/lib/redis";
import { isLocalUrl, loadLocalEnv, readCounter, setCounter } from "./ops";
import {
  connectionInfo,
  distinctPhase,
  printTable,
  runStandardPhases,
  type PhaseReport,
} from "./stress-core";

const PORT = Number(process.env.STRESS_PORT ?? 3123);
const BASE_URL = `http://localhost:${PORT}`;
const MAX = 1_000_000;

function startServer(env: NodeJS.ProcessEnv): ChildProcess {
  const require = createRequire(__filename);
  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // Keep the server's output for diagnostics, but skip the per-request allocation logs.
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim() && (!line.includes('"token.') || process.env.STRESS_VERBOSE))
        process.stdout.write(`  [next] ${line}\n`);
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim() && (!line.includes('"token.') || process.env.STRESS_VERBOSE))
        process.stderr.write(`  [next:err] ${line}\n`);
    }
  });
  return child;
}

function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function waitForServer(url: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not become ready at ${url}`);
}

async function main() {
  loadLocalEnv();
  const creds = resolveRedisCredentials();
  if (!isLocalUrl(creds.url)) {
    throw new Error(
      `Refusing to run: Redis URL ${new URL(creds.url).host} is not local. ` +
        "stress:local resets the counter and must only run against docker-compose Redis.",
    );
  }
  if (!existsSync(".next/BUILD_ID"))
    throw new Error('No production build found. Run "npm run build" first.');

  const redis = createRedis(creds);
  try {
    await redis.ping();
  } catch {
    throw new Error('Local Redis not reachable. Run "npm run redis:up" first.');
  }

  await setCounter(redis, 0);
  console.log(`Counter reset to 0. Starting production server on ${BASE_URL}…`);

  const server = startServer({
    ...process.env,
    NODE_ENV: "production",
    UPSTASH_REDIS_REST_URL: creds.url,
    UPSTASH_REDIS_REST_TOKEN: creds.token,
    MAX_TOKENS: String(MAX),
    // All stress traffic comes from one IP. Raise the limit for this run only.
    RATE_LIMIT_PER_10S: "1000000",
  });
  const cleanup = () => stopServer(server);
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(130));

  let reports: PhaseReport[] = [];
  try {
    await waitForServer(BASE_URL);
    console.log(`Server ready. Client transport: ${connectionInfo}.\n`);

    // Phases 1-4: 50 → 500 → 5,000 distinct + 20 × same.
    reports = await runStandardPhases(BASE_URL, MAX);
    const first = reports[0];
    if (first && first.numbers[0] !== 1) {
      first.pass = false;
      first.notes.push(`after reset the first number should be 1, got ${first.numbers[0]}`);
    }
    // Integrity: every number Redis issued was delivered to someone
    // (counter == numbers received), so none was burned.
    const delivered = new Set(reports.flatMap((r) => r.numbers)).size;
    const counter = await readCounter(redis);
    reports.push({
      name: "Redis counter = delivered",
      requests: 0,
      ok: 0,
      retried: 0,
      failed: 0,
      unique: delivered,
      range: `counter=${counter}`,
      contiguous: counter === delivered,
      withinLimit: counter <= MAX,
      soldOut: 0,
      p50: 0,
      p95: 0,
      max: 0,
      wallMs: 0,
      pass: counter === delivered,
      notes:
        counter === delivered
          ? []
          : [`counter is ${counter} but ${delivered} numbers were delivered (burned numbers)`],
      numbers: [],
    });

    // Phase 5: sold-out race over HTTP.
    await setCounter(redis, MAX - 100);
    const race = await distinctPhase(BASE_URL, 500, {
      maxTokens: MAX,
      expectStart: MAX - 99,
      expectSoldOut: 400,
      name: "500 racing for last 100",
    });
    if (race.numbers.length !== 100 || race.numbers[race.numbers.length - 1] !== MAX) {
      race.pass = false;
      race.notes.push(`expected exactly 100 numbers ending at ${MAX}`);
    }
    const finalCounter = await readCounter(redis);
    if (finalCounter !== MAX) {
      race.pass = false;
      race.notes.push(`counter ended at ${finalCounter}, expected ${MAX}`);
    }
    reports.push(race);
  } finally {
    stopServer(server);
    await setCounter(redis, 0).catch(() => {});
  }

  console.log("");
  printTable(reports);
  const ok = reports.every((r) => r.pass);
  console.log(ok ? "\nSTRESS: PASS" : "\nSTRESS: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
