/** Supersede tokens: only the most recent `begin()` stays current until `invalidate()` or another `begin()`. */
export function createLatest() {
  let counter = 0;
  return {
    begin(): () => boolean {
      const mine = ++counter;
      return () => mine === counter;
    },
    invalidate(): void {
      counter++;
    },
  };
}
