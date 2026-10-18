import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { unsupportedChars, unsupportedMessage } from "../../lib/editor/afm";
import { LIMITS, type TextItem } from "../../lib/editor/model";
import { visibleToPreviewRect, type Size } from "../../lib/editor/geometry";
import { cssColor, cssFont } from "./svgStyle";

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
 * The PDF wraps with AFM metrics; the box grows on commit so no line is lost.
 */
export default function TextEditOverlay({ item, previewSize, pageSize, onCommit }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(item.text);
  const [areaHeight, setAreaHeight] = useState(0);
  const committed = useRef(false);
  const messageId = useId();

  useEffect(() => {
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
  const bad = unsupportedChars(text);

  // Grow with the content (never shorter than the box) so no typed line is hidden.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const height = Math.max(box.height, el.scrollHeight);
    el.style.height = `${height}px`;
    setAreaHeight(height);
  }, [text, box.height, box.width, item.size, item.font, item.lineHeight]);

  return (
    <>
      <textarea
        ref={ref}
        value={text}
        maxLength={LIMITS.textChars}
        aria-label="Text box content"
        aria-invalid={bad !== ""}
        aria-describedby={bad !== "" ? messageId : undefined}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            e.stopPropagation();
            commit(true);
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute z-10 resize-none overflow-hidden border-0 bg-white/70 p-0 outline outline-2 outline-mantis-500 focus:ring-0"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          fontFamily: cssFont(item.font).family,
          fontWeight: cssFont(item.font).weight,
          fontSize: item.size * scale,
          lineHeight: item.lineHeight,
          textAlign: item.align,
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
          style={{ left: box.left, top: box.top + Math.max(box.height, areaHeight) + 4 }}
        >
          {unsupportedMessage(bad)}. They cannot be saved with the standard PDF fonts.
        </p>
      )}
    </>
  );
}
