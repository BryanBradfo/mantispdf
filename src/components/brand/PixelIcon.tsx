import type { PixelGlyph } from "../../lib/pixelIcons";

/** SVG path for a glyph: each horizontal run of `#` becomes one 1 px tall rect (`M x y h w v 1 h -w z`). */
export function glyphPath(glyph: PixelGlyph): string {
  let d = "";
  glyph.forEach((row, y) => {
    for (const run of row.matchAll(/#+/g)) {
      const x = run.index ?? 0;
      const w = run[0].length;
      d += `M${x} ${y}h${w}v1h-${w}z`;
    }
  });
  return d;
}

interface Props {
  icon: PixelGlyph;
  className?: string;
  /** Names the icon for assistive tech; without it the icon is decorative (aria-hidden). */
  title?: string;
}

/**
 * A hand-drawn 16x16 tool icon: pure ink in currentColor, no anti-aliasing (crispEdges). Size it in
 * multiples of 16 px (h-4, h-8) for whole-pixel edges; h-6 (24 px) still reads cleanly.
 */
export default function PixelIcon({ icon, className, title }: Props) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="crispEdges"
      className={className}
      {...(title ? { role: "img" } : { "aria-hidden": true })}
    >
      {title && <title>{title}</title>}
      <path d={glyphPath(icon)} />
    </svg>
  );
}
