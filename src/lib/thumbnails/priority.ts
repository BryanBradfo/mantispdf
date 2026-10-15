import type { QueuedJob } from "./types";

/** Index in `queue` (non-empty) of the job to render next. */
export function pickNext(queue: readonly QueuedJob[]): number {
  return queue.length > 0 ? 0 : -1;
}
