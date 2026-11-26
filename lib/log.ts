/**
 * Structured (single-line JSON) server logs. Vercel's log drains index these
 * fields directly.
 *
 * Never put personal data here: no visitor id, IP, cookie or User-Agent.
 * Only the event, the outcome, the number and timing.
 */
type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(
  event: string,
  fields: LogFields = {},
  level: "info" | "warn" | "error" = "info",
) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** Error name and message only. Stack traces can leak internals into log drains. */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      err.cause instanceof Error ? ` (cause: ${err.cause.name}: ${err.cause.message})` : "";
    return `${err.name}: ${err.message}${cause}`.slice(0, 500);
  }
  return String(err).slice(0, 500);
}
