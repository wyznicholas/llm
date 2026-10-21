// Retry one network step, not the whole run.
//
// The routine runs at 10:15, often seconds after the Mac wakes, and its
// network reads have failed in two ways that a short wait fixes: GitLab
// resetting the connection mid-listing (2026-10-19, page 21 of ~30) and a
// timeout on the first request after wake (2026-10-21). Each step retries on
// its own so one dropped page or request costs seconds, not the day.

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 5_000,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < attempts) {
        const wait = baseDelayMs * attempt;
        console.error(
          `${label}: attempt ${attempt} failed (${String(err).slice(0, 200)}); retrying in ${wait / 1000}s`,
        );
        await Bun.sleep(wait);
      }
    }
  }
  throw new Error(`${label}: gave up after ${attempts} attempts: ${String(last).slice(0, 500)}`);
}
