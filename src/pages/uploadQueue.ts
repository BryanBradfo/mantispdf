interface Handlers<T> {
  onResult: (result: T) => void;
  onError: (err: unknown) => void;
  /** Number of batches queued or in flight (0 when idle). */
  onPending: (count: number) => void;
}

/**
 * Runs upload batches one at a time in the order they were enqueued, so every
 * drop lands. `cancel()` makes queued batches skip and ignores the result of
 * the one in flight.
 */
export function createUploadQueue<T>({ onResult, onError, onPending }: Handlers<T>) {
  let generation = 0;
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();

  function enqueue(job: () => Promise<T>): void {
    const mine = generation;
    onPending(++pending);
    tail = tail.then(async () => {
      if (mine !== generation) return;
      try {
        const result = await job();
        if (mine === generation) onResult(result);
      } catch (err) {
        if (mine === generation) onError(err);
      } finally {
        if (mine === generation) onPending(--pending);
      }
    });
  }

  function cancel(): void {
    generation++;
    pending = 0;
    onPending(0);
  }

  return { enqueue, cancel };
}
