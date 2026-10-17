/**
 * Arrow-key move in a row-major grid of `count` cells, `cols` wide (count a multiple of cols).
 * Left/Right step one cell and wrap through the grid; Up/Down step one row and wrap within the
 * column. Returns null for any other key.
 */
export function gridStep(index: number, key: string, cols: number, count: number): number | null {
  const step =
    key === "ArrowRight" ? 1
    : key === "ArrowLeft" ? -1
    : key === "ArrowDown" ? cols
    : key === "ArrowUp" ? -cols
    : 0;
  if (step === 0) return null;
  return (((index + step) % count) + count) % count;
}
