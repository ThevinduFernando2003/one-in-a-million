/**
 * Stress a RUNNING app over HTTP.
 *
 *   npm run stress                                   # http://localhost:3000
 *   BASE_URL=http://localhost:3123 npm run stress
 *   npm run stress -- --sizes 50,500,5000
 *
 * Run it against a local or staging deployment with no other traffic and
 * with RATE_LIMIT_PER_10S raised. From one machine all requests share one
 * IP, and the production limit (300 / 10 s) would correctly answer 429.
 * The contiguity and "arrival order" checks assume nobody else is taking
 * numbers during the run.
 *
 * For a fully automated run (build, start, reset, stress, sold-out race),
 * use `npm run stress:local`.
 */
import { parseMaxTokens } from "@/lib/config";
import { connectionInfo, printTable, runStandardPhases } from "./stress-core";

async function main() {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const maxTokens = parseMaxTokens(process.env.MAX_TOKENS);
  const i = process.argv.indexOf("--sizes");
  const sizes =
    i !== -1 && process.argv[i + 1]
      ? process.argv[i + 1]!.split(",").map((s) => Number(s.trim()))
      : [50, 500, 5000];
  if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error("--sizes must be positive integers");

  console.log(
    `Stressing ${baseUrl} with phases ${sizes.join(" → ")} + 20 × same visitor (${connectionInfo})…`,
  );
  const reports = await runStandardPhases(baseUrl, maxTokens, sizes);
  printTable(reports);
  const ok = reports.every((r) => r.pass);
  console.log(ok ? "\nSTRESS: PASS" : "\nSTRESS: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
