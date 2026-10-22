import { useEffect, useState } from "react";
import type { NotoFamily, Point, TextItem } from "../../lib/editor/model";
import { planFonts } from "../../lib/editor/unicodeText";
import type { TextLayout } from "../../lib/fonts/jobFonts";
import { ensureFontFace, fontFaceFamily } from "../../lib/fonts/fontFaces";
import { cssColor } from "./svgStyle";
import { useUnicodeText } from "./unicodeTextContext";

/** Synthetic bold stroke (em), as the engine draws it (`FAKE_BOLD_EM`). */
const FAKE_BOLD_EM = 0.03;
/** Wait after the last change before asking the engine for a new layout. */
const DEBOUNCE_MS = 120;

interface Props {
  item: TextItem;
  family: NotoFamily;
  bold: boolean;
  /** Visible points to preview pixels. */
  toPx: (p: Point) => Point;
  /** Preview pixels per point. */
  scale: number;
  /** The box in preview pixels. */
  box: { left: number; top: number; width: number; height: number };
}

/**
 * A text box drawn with embedded fonts: the engine's own lines (`layout_text`), each run drawn with
 * the same font file loaded as a FontFace, so the preview breaks lines exactly like the PDF.
 */
export default function NotoText({ item, family, bold, toPx, scale, box }: Props) {
  const env = useUnicodeText();
  const plan = env?.manifest ? planFonts(env.manifest, item.text, family, bold, env.cjk) : null;
  const files = plan?.faces.map((f) => f.file) ?? [];
  const fakeBold = new Set(plan?.fakeBold.map((f) => f.file) ?? []);
  const key = JSON.stringify([files, item.text, item.size, item.rect[2], item.rect[3], item.align, item.lineHeight]);
  const [shown, setShown] = useState<{ key: string; layout: TextLayout | null; files: string[] } | null>(null);
  // The box grows to its engine layout once per content change (text, fonts, size, alignment,
  // line height), never after the user resizes it: its size is not part of the content.
  const content = JSON.stringify([files, item.text, item.size, item.align, item.lineHeight]);
  useEffect(() => {
    if (!shown?.layout || !env?.fit || !env.fitted || shown.key !== key || env.fitted.get(item.id) === content) return;
    env.fitted.set(item.id, content);
    if (shown.layout.height > item.rect[3] + 1e-6) env.fit(item.id, shown.layout.height);
  }, [shown, key, content, env, item.id, item.rect]);

  useEffect(() => {
    if (!env || files.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const request = {
        fonts: files,
        text: item.text,
        size: item.size,
        width: item.rect[2],
        height: item.rect[3],
        align: item.align,
        lineHeight: item.lineHeight,
      };
      Promise.all([env.layoutText(request), ...files.map(ensureFontFace)])
        .then(([layout]) => {
          if (!cancelled) setShown({ key, layout, files });
        })
        .catch(() => {
          if (!cancelled) setShown({ key, layout: null, files });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` covers every input of the layout.
  }, [key, env]);

  const failed = shown !== null && shown.layout === null;
  const missing = plan?.missing ?? "";
  const [x0, y0, , h] = item.rect;
  return (
    <g>
      {(missing !== "" || failed) && (
        <rect
          data-warning="unsupported-text"
          x={box.left}
          y={box.top}
          width={box.width}
          height={box.height}
          fill="none"
          stroke="#dc2626"
          strokeWidth={2}
          strokeDasharray="5 3"
        >
          <title>{failed ? "The fonts for this text could not be loaded" : "Some characters have no font"}</title>
        </rect>
      )}
      {shown?.layout && (
        <g opacity={item.opacity} fill={cssColor(item.color)} fontSize={item.size * scale} data-testid="noto-text">
          {shown.layout.lines.flatMap((line, i) =>
            line.runs.map((run, k) => {
              const file = shown.files[run.face] ?? "";
              // A right-to-left run is laid out right to left from its right edge: in a
              // left-to-right text element a neutral at its end (a comma, a stop) would be
              // put on the wrong side.
              const [x, y] = toPx([x0 + run.x + (run.rtl ? run.width : 0), y0 + h - line.baselineY]);
              const stroke = fakeBold.has(file) ? { stroke: cssColor(item.color), strokeWidth: FAKE_BOLD_EM * item.size * scale } : {};
              return (
                <text
                  key={`${i}-${k}`}
                  x={x}
                  y={y}
                  fontFamily={fontFaceFamily(file)}
                  direction={run.rtl ? "rtl" : "ltr"}
                  style={{ whiteSpace: "pre", unicodeBidi: "embed" }}
                  {...stroke}
                  {...(run.width > 0 ? { textLength: run.width * scale, lengthAdjust: "spacingAndGlyphs" } : {})}
                >
                  {run.text}
                </text>
              );
            }),
          )}
        </g>
      )}
    </g>
  );
}
