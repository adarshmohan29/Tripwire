const BASE_MS = 1000;
const CAP_MS = 30_000;

// Full jitter: events that failed together retry at spread-out times instead of in lockstep.
export function delay(attempt: number): number {
  return Math.floor(Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt));
}
