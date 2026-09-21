export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const defaultBackoff: BackoffOptions = {
  baseMs: 30_000,
  maxMs: 300_000,
};

// Doubles the poll interval per consecutive failure, capped at maxMs.
// failures = 0 means healthy polling at the base interval.
export function nextPollDelay(failures: number, options: BackoffOptions = defaultBackoff): number {
  if (failures <= 0) return options.baseMs;
  return Math.min(options.baseMs * 2 ** failures, options.maxMs);
}
