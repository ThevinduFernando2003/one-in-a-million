/**
 * Concurrency stress test over real HTTP against a running app.
 *
 * Each phase fires N POST /api/token requests at the same instant (one
 * Promise.all burst), each with its own visitor cookie, and asserts:
 *   - every visitor ends up with a valid answer (HTTP 200)
 *   - all numbers are unique (no duplicates)
 *   - they are contiguous (sorted, each is the previous + 1), so nothing
 *     was skipped or burned
 *   - they are within 1..maxTokens
 *   - phases are in arrival order (each phase starts right after the last)
 * Plus a same-visitor phase: 20 simultaneous requests sharing ONE cookie
 * must all return the same number, and exactly one of them is "new".
 *
 * Like the real browser client (lib/token-client.ts), a request that fails
 * at the transport level (e.g. the OS refusing yet another simultaneous TCP
 * connection) or with 429/5xx is retried with the SAME cookie, using
 * exponential backoff with jitter, up to 5 attempts. The assertions stay
 * strict: if a retry ever caused a burned number it would show up as a gap
 * (and as a counter mismatch in stress-local).
 */
import http from "node:http";
import https from "node:https";
import { backoffDelay, isRetryableStatus, MAX_ATTEMPTS } from "@/lib/token-client";

const UA = "Mozilla/5.0 (X11; Linux x86_64) oiam-stress/1.0";

export type TokenBody = {
  number: number | null;
  isNew: boolean;
  soldOut: boolean;
  theme: string;
  milestone: string | null;
};
type Outcome =
  | { ok: true; body: TokenBody; ms: number; attempts: number }
  | { ok: false; status: number; error: string; ms: number; attempts: number };

export type PhaseReport = {
  name: string;
  requests: number;
  ok: number;
  retried: number;
  failed: number;
  unique: number;
  range: string;
  contiguous: boolean;
  withinLimit: boolean;
  soldOut: number;
  p50: number;
  p95: number;
  max: number;
  wallMs: number;
  pass: boolean;
  notes: string[];
  numbers: number[];
};

function pct(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

type Attempt =
  | { ok: true; body: TokenBody }
  | { ok: false; status: number; error: string; retryAfterMs?: number };

/**
 * Connection pool. All requests of a phase are launched at the same instant
 * and are all in flight together. They are carried over at most
 * STRESS_CONNECTIONS keep-alive sockets (default 256), the way a load
 * balancer / CDN edge fronts serverless functions. Without a cap, the OS
 * loopback stack becomes the bottleneck. On Windows a bare Node HTTP server
 * drops about half of 500 simultaneous TCP connects. STRESS_CONNECTIONS=0
 * opens one socket per request.
 */
const CONNECTIONS = Number(process.env.STRESS_CONNECTIONS ?? 256);
const agentOpts = { keepAlive: true, maxSockets: CONNECTIONS > 0 ? CONNECTIONS : Infinity };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);
export const connectionInfo =
  CONNECTIONS > 0 ? `${CONNECTIONS} pooled keep-alive connections` : "one socket per request";

function request(url: URL, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(
        url,
        {
          method: "POST",
          agent: url.protocol === "https:" ? httpsAgent : httpAgent,
          headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
          timeout: 60_000,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("client timeout")));
      req.on("error", reject);
      req.end(body);
    },
  );
}

async function attemptOnce(baseUrl: string, visitorId: string): Promise<Attempt> {
  try {
    const url = new URL("/api/token", baseUrl);
    const res = await request(
      url,
      {
        "Content-Type": "application/json",
        Origin: url.origin,
        "User-Agent": UA,
        "Sec-Fetch-Site": "same-origin",
        Cookie: `oiam_vid=${visitorId}`,
      },
      "{}",
    );
    if (res.status !== 200) {
      const ra = Number(res.headers["retry-after"]);
      return {
        ok: false,
        status: res.status,
        error: res.text.slice(0, 200),
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
      };
    }
    return { ok: true, body: JSON.parse(res.text) as TokenBody };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, status: 0, error: `${String(err)}${code ? ` (${code})` : ""}` };
  }
}

/** One visitor's request, with the client's retry policy (same cookie every time). */
async function post(baseUrl: string, visitorId: string): Promise<Outcome> {
  const t0 = performance.now();
  let last: Attempt = { ok: false, status: 0, error: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await attemptOnce(baseUrl, visitorId);
    if (last.ok)
      return { ok: true, body: last.body, ms: performance.now() - t0, attempts: attempt };
    const retryable = last.status === 0 || isRetryableStatus(last.status);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    await new Promise((r) =>
      setTimeout(
        r,
        Math.max(backoffDelay(attempt), (last as { retryAfterMs?: number }).retryAfterMs ?? 0),
      ),
    );
  }
  const f = last as Extract<Attempt, { ok: false }>;
  return {
    ok: false,
    status: f.status,
    error: f.error,
    ms: performance.now() - t0,
    attempts: MAX_ATTEMPTS,
  };
}

function summarizeFailures(outcomes: Outcome[], notes: string[]) {
  const failures = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
  if (!failures.length) return;
  const byStatus = new Map<number, number>();
  for (const f of failures) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
  notes.push(
    `failed after ${MAX_ATTEMPTS} attempts, by status: ${[...byStatus].map(([s, c]) => `${s}×${c}`).join(", ")}`,
  );
  notes.push(`sample error: ${failures[0]!.error}`);
}

/** Fire `n` simultaneous requests, each from a distinct visitor. */
export async function distinctPhase(
  baseUrl: string,
  n: number,
  opts: { maxTokens: number; expectStart?: number; expectSoldOut?: number; name?: string },
): Promise<PhaseReport> {
  const ids = Array.from({ length: n }, () => crypto.randomUUID());
  const t0 = performance.now();
  const outcomes = await Promise.all(ids.map((id) => post(baseUrl, id)));
  const wallMs = performance.now() - t0;

  const notes: string[] = [];
  const bodies = outcomes
    .filter((o): o is Extract<Outcome, { ok: true }> => o.ok)
    .map((o) => o.body);
  const failed = outcomes.length - bodies.length;
  const retried = outcomes.filter((o) => o.attempts > 1).length;
  const numbers = bodies.filter((b) => b.number !== null).map((b) => b.number!);
  const soldOut = bodies.filter((b) => b.soldOut).length;
  numbers.sort((a, b) => a - b);

  const unique = new Set(numbers).size;
  let contiguous = true;
  for (let i = 1; i < numbers.length; i++)
    if (numbers[i] !== numbers[i - 1]! + 1) contiguous = false;
  const withinLimit = numbers.every(
    (x) => Number.isSafeInteger(x) && x >= 1 && x <= opts.maxTokens,
  );
  const allNew = bodies.filter((b) => b.number !== null).every((b) => b.isNew);

  summarizeFailures(outcomes, notes);
  if (unique !== numbers.length) notes.push(`DUPLICATES: ${numbers.length - unique}`);
  if (!contiguous) notes.push("GAP in issued numbers");
  if (!withinLimit) notes.push("number outside 1..max");
  if (!allNew) notes.push("a distinct visitor was told isNew=false");

  const expectedSoldOut = opts.expectSoldOut ?? 0;
  if (soldOut !== expectedSoldOut)
    notes.push(`sold out: expected ${expectedSoldOut}, got ${soldOut}`);
  const orderOk =
    opts.expectStart === undefined || numbers.length === 0 || numbers[0] === opts.expectStart;
  if (!orderOk) notes.push(`order: expected first number ${opts.expectStart}, got ${numbers[0]}`);

  const lat = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const pass =
    failed === 0 &&
    unique === numbers.length &&
    contiguous &&
    withinLimit &&
    allNew &&
    soldOut === expectedSoldOut &&
    numbers.length + soldOut === n &&
    orderOk;

  return {
    name: opts.name ?? `${n} distinct visitors`,
    requests: n,
    ok: bodies.length,
    retried,
    failed,
    unique,
    range: numbers.length ? `${numbers[0]}–${numbers[numbers.length - 1]}` : "—",
    contiguous,
    withinLimit,
    soldOut,
    p50: Math.round(pct(lat, 50)),
    p95: Math.round(pct(lat, 95)),
    max: Math.round(lat[lat.length - 1] ?? 0),
    wallMs: Math.round(wallMs),
    pass,
    notes,
    numbers,
  };
}

/** 20 (or n) simultaneous requests sharing ONE cookie must yield ONE number. */
export async function sameVisitorPhase(
  baseUrl: string,
  n = 20,
  expectStart?: number,
): Promise<PhaseReport> {
  const id = crypto.randomUUID();
  const t0 = performance.now();
  const outcomes = await Promise.all(Array.from({ length: n }, () => post(baseUrl, id)));
  const wallMs = performance.now() - t0;
  const bodies = outcomes
    .filter((o): o is Extract<Outcome, { ok: true }> => o.ok)
    .map((o) => o.body);
  const distinct = [...new Set(bodies.map((b) => b.number))];
  const newCount = bodies.filter((b) => b.isNew).length;
  const failed = outcomes.length - bodies.length;
  const notes: string[] = [];
  summarizeFailures(outcomes, notes);
  if (distinct.length !== 1)
    notes.push(`expected 1 number, got ${distinct.length}: ${distinct.join(", ")}`);
  if (newCount !== 1) notes.push(`expected exactly 1 isNew=true, got ${newCount}`);
  const nums = distinct.filter((d): d is number => typeof d === "number");
  const orderOk = expectStart === undefined || nums[0] === expectStart;
  if (!orderOk) notes.push(`order: expected ${expectStart}, got ${nums[0]}`);
  const lat = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  return {
    name: `${n} × same visitor`,
    requests: n,
    ok: bodies.length,
    retried: outcomes.filter((o) => o.attempts > 1).length,
    failed,
    unique: distinct.length,
    range: distinct.join(", "),
    contiguous: true,
    withinLimit: nums.every((x) => x >= 1 && x <= 1_000_000),
    soldOut: bodies.filter((b) => b.soldOut).length,
    p50: Math.round(pct(lat, 50)),
    p95: Math.round(pct(lat, 95)),
    max: Math.round(lat[lat.length - 1] ?? 0),
    wallMs: Math.round(wallMs),
    pass: failed === 0 && distinct.length === 1 && newCount === 1 && orderOk,
    notes,
    numbers: nums,
  };
}

export function printTable(reports: PhaseReport[]) {
  const rows = reports.map((r) => ({
    Phase: r.name,
    Reqs: r.requests,
    OK: r.ok,
    Retried: r.retried,
    Failed: r.failed,
    Unique: r.unique,
    Range: r.range,
    Contiguous: r.contiguous ? "yes" : "NO",
    "≤ limit": r.withinLimit ? "yes" : "NO",
    "Sold out": r.soldOut,
    "p50 ms": r.p50,
    "p95 ms": r.p95,
    "max ms": r.max,
    "wall ms": r.wallMs,
    Result: r.pass ? "PASS" : "FAIL",
  }));
  const cols = Object.keys(rows[0] ?? {}) as (keyof (typeof rows)[number])[];
  const width = cols.map((c) =>
    Math.max(String(c).length, ...rows.map((r) => String(r[c]).length)),
  );
  const line = (cells: string[]) =>
    "│ " + cells.map((c, i) => c.padEnd(width[i]!)).join(" │ ") + " │";
  const sep = (l: string, m: string, r: string) =>
    l + width.map((w) => "─".repeat(w + 2)).join(m) + r;
  console.log(sep("┌", "┬", "┐"));
  console.log(line(cols.map(String)));
  console.log(sep("├", "┼", "┤"));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
  console.log(sep("└", "┴", "┘"));
  for (const r of reports) for (const n of r.notes) console.log(`  ! ${r.name}: ${n}`);
}

/**
 * Standard run: 50 → 500 → 5,000 distinct visitors, then 20 × same visitor.
 * Phases must also be in arrival order relative to one another.
 */
export async function runStandardPhases(
  baseUrl: string,
  maxTokens: number,
  sizes = [50, 500, 5000],
) {
  const reports: PhaseReport[] = [];
  let expectStart: number | undefined;
  for (const n of sizes) {
    const r = await distinctPhase(baseUrl, n, { maxTokens, expectStart });
    reports.push(r);
    // The next phase must begin right after this one (if nobody else is using the app).
    if (r.numbers.length) expectStart = r.numbers[r.numbers.length - 1]! + 1;
  }
  reports.push(await sameVisitorPhase(baseUrl, 20, expectStart));
  return reports;
}
