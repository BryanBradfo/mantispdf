import { useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { LIMITS, type TextItem } from "../../lib/editor/model";
import { visibleToPreviewRect, type Size } from "../../lib/editor/geometry";
import { cssColor, cssFont, textareaBaselineShift } from "./svgStyle";
import { metricFont, missingMessage, planFonts, resolveFont } from "../../lib/editor/unicodeText";
import { useUnicodeText } from "./unicodeTextContext";

interface Props {
  item: TextItem;
  previewSize: Size;
  pageSize: Size;
  /**
   * Called once: when the textarea loses focus (`byKey` false) or on Escape / Ctrl+Enter
   * (`byKey` true, the caller moves focus back to the canvas).
   */
  onCommit: (text: string, byKey: boolean) => void;
}

/**
 * Textarea over a text box, in the box's font (CSS approximation) and size scaled to the preview.
 * While typing, the browser wraps (an accepted approximation); the canvas and the PDF use the engine
 * layout, and the box grows on commit so no line is lost. The textarea is shifted so its first
 * baseline sits where the engine draws it, and the text does not jump on commit.
 */
export default function TextEditOverlay({ item, previewSize, pageSize, onCommit }: Props) {
  const t = useT("editPdf");
  const tc = useT("common");
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(item.text);
  const [areaHeight, setAreaHeight] = useState(0);
  const committed = useRef(false);
  const messageId = useId();

  // Layout effect: focus before the browser handles the next key, so nothing typed right after
  // the click goes to the page shortcuts.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const commit = (byKey: boolean) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text, byKey);
  };

  const box = visibleToPreviewRect(item.rect, previewSize, pageSize);
  const scale = previewSize[0] / pageSize[0];
  const env = useUnicodeText();
  // Characters no font can show (text the standard fonts cannot encode switches to Noto; until
  // the font list is known, nothing is flagged).
  const resolved = resolveFont(item.font, text);
  const bad =
    resolved.kind === "noto" && env?.manifest ? planFonts(env.manifest, text, resolved.family, resolved.bold, env.cjk).missing : "";
  const metric = metricFont(item.font);
  const fontPx = item.size * scale;
  // Usually negative: the textarea starts a little above the box, the outline stays on the box.
  const shift = textareaBaselineShift(metric, item.lineHeight) * fontPx;
  const minHeight = box.height - shift;

  // Grow with the content (never shorter than the box) so no typed line is hidden.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const height = Math.max(minHeight, el.scrollHeight);
    el.style.height = `${height}px`;
    setAreaHeight(height);
  }, [text, minHeight, box.width, fontPx, item.font, item.lineHeight]);

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute z-10 outline outline-2 outline-mantis-500"
        style={{ left: box.left, top: box.top, width: box.width, height: Math.max(box.height, areaHeight + shift) }}
      />
      <textarea
        ref={ref}
        value={text}
        maxLength={LIMITS.textChars}
        aria-label={t("textContent")}
        aria-invalid={bad !== ""}
        aria-describedby={bad !== "" ? messageId : undefined}
        spellCheck
        dir="auto"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          // Switching to another window blurs too: keep editing, focus comes back with the window.
          if (e.relatedTarget === null && (!document.hasFocus() || document.visibilityState === "hidden")) return;
          commit(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            e.stopPropagation();
            commit(true);
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute z-10 resize-none overflow-hidden border-0 bg-white/70 p-0 outline-none focus:ring-0"
        style={{
          left: box.left,
          top: box.top + shift,
          width: box.width,
          fontFamily: cssFont(metric).family,
          fontWeight: cssFont(metric).weight,
          fontSize: fontPx,
          lineHeight: item.lineHeight,
          textAlign: item.align === "auto" ? "start" : item.align,
          color: cssColor(item.color),
          opacity: Math.max(item.opacity, 0.4),
          textDecorationLine: bad !== "" ? "underline" : undefined,
          textDecorationStyle: bad !== "" ? "wavy" : undefined,
          textDecorationColor: bad !== "" ? "#dc2626" : undefined,
        }}
      />
      {bad !== "" && (
        <p
          id={messageId}
          role="alert"
          className="absolute z-10 max-w-xs rounded-md bg-red-600 px-2 py-1 text-xs text-white shadow"
          style={{ left: box.left, top: box.top + Math.max(box.height, areaHeight + shift) + 4 }}
        >
          {missingMessage(bad, tc)}
        </p>
      )}
    </>
  );
}
