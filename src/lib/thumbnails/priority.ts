import type { QueuedJob } from "./types";

/** Index in `queue` (non-empty) of the job to render next. */
export function pickNext(queue: readonly QueuedJob[]): number {
  const rank = (j: QueuedJob) => [j.visible ? 0 : 1, j.page === 1 ? 0 : 1, j.width, j.seq];
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    if (best === -1) { best = i; continue; }
    const a = rank(queue[i]), b = rank(queue[best]);
    const k = a.findIndex((v, n) => v !== b[n]);
    if (k !== -1 && a[k] < b[k]) best = i;
  }
  return best;
}
