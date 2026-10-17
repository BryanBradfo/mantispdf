import PageImage from "../common/PageImage";
import type { Rect } from "../../lib/geometryJob";

export interface PreviewItem {
  /** Rect on the sheet in points, origin bottom-left. */
  rect: Rect;
  /** 1-based page to show as a thumbnail; omitted draws an empty placeholder. */
  page?: number;
}

interface Props {
  sheet: [number, number];
  items: PreviewItem[];
  /** Outlines of the grid cells, drawn dashed (N-up). */
  cells?: Rect[];
  /** Draw each cell with a solid border (N-up border option). */
  bordered?: boolean;
  source: Blob | Uint8Array;
  label: string;
  /** Longest side in CSS pixels. */
  maxSide?: number;
}

/** Mini-preview of one output sheet: SVG outlines plus page thumbnails positioned in percent. */
export default function SheetPreview({ sheet, items, cells = [], bordered = false, source, label, maxSide = 220 }: Props) {
  const [sw, sh] = sheet;
  const scale = maxSide / Math.max(sw, sh);
  const pct = ([x, y, w, h]: Rect) => ({
    left: `${(x / sw) * 100}%`,
    top: `${((sh - y - h) / sh) * 100}%`,
    width: `${(w / sw) * 100}%`,
    height: `${(h / sh) * 100}%`,
  });

  return (
    <div
      role="img"
      aria-label={label}
      data-testid="sheet-preview"
      className="relative shrink-0 bg-white shadow ring-1 ring-gray-300 dark:bg-[#1e1e1e] dark:ring-[#444]"
      style={{ width: sw * scale, height: sh * scale }}
    >
      <svg viewBox={`0 0 ${sw} ${sh}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
        {cells.map(([x, y, w, h], i) => (
          <rect
            key={i}
            x={x}
            y={sh - y - h}
            width={w}
            height={h}
            fill="none"
            stroke={bordered ? "#374151" : "#9ca3af"}
            strokeWidth={bordered ? 1 : 0.75}
            strokeDasharray={bordered ? undefined : "4 3"}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {items.map((item, i) => (
        <div key={i} className="absolute overflow-hidden ring-1 ring-mantis-400/70" style={pct(item.rect)}>
          {item.page !== undefined && (
            <PageImage source={source} page={item.page} width={120} alt="" className="!aspect-auto h-full" />
          )}
        </div>
      ))}
    </div>
  );
}
