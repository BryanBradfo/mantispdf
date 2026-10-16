/** CSS transform that shows a portrait thumbnail rotated by `deg`, scaled to stay inside its box. */
export function thumbnailTransform(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  // Rotated 90/270 the page is landscape: shrink by 8.5/11 to fit the portrait container.
  const scale = norm === 90 || norm === 270 ? 8.5 / 11 : 1;
  return `rotate(${norm}deg) scale(${scale})`;
}
