import { useCallback, useEffect, useRef, useState } from "react";
import { DECODE_FRAME_MS, decodeDuration, scrambleFrame } from "../../lib/decode";

interface Props {
  text: string;
  /**
   * "mount": decode once when shown (and again if the text changes, e.g. a language switch).
   * "hover": decode each time the closest link or button ancestor is hovered or focused; the parent
   * passes nothing else, so a cell or menu row only wraps its title.
   */
  trigger: "mount" | "hover";
  /** Classes for the wrapping span (an inline span, so the text wraps like plain text). */
  className?: string;
}

/** No effect under prefers-reduced-motion, nor where matchMedia is missing (jsdom in unit tests). */
function motionAllowed(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A title that "decodes": glyphs cycle, then settle left to right on the final text (about 500 ms,
 * once per trigger). The real text stays in the DOM as the only text content, so the accessible name
 * and `textContent` are always final; while it runs, unsettled characters are transparent (still
 * reserving their exact width, so nothing shifts or rewraps) and an aria-hidden overlay paints each
 * glyph through CSS generated content (`data-decode`), which never reaches `textContent`.
 */
export default function DecodeText({ text, trigger, className = "" }: Props) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [frame, setFrame] = useState<string | null>(null);

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    timer.current = undefined;
  }, []);

  const play = useCallback(() => {
    // A run in progress is left to finish (hover then click-focus would otherwise restart it).
    if (timer.current !== undefined || !motionAllowed()) return;
    const total = decodeDuration(text);
    let elapsed = 0;
    setFrame(scrambleFrame(text, 0, Math.random));
    timer.current = window.setInterval(() => {
      elapsed += DECODE_FRAME_MS;
      if (elapsed >= total) {
        stop();
        setFrame(null);
      } else {
        setFrame(scrambleFrame(text, elapsed / total, Math.random));
      }
    }, DECODE_FRAME_MS);
  }, [text, stop]);

  useEffect(() => {
    if (trigger === "mount") play();
    return () => {
      stop();
      setFrame(null);
    };
  }, [trigger, play, stop]);

  useEffect(() => {
    if (trigger !== "hover") return;
    const host = rootRef.current?.closest<HTMLElement>("a, button");
    if (!host) return;
    host.addEventListener("pointerenter", play);
    host.addEventListener("focus", play);
    return () => {
      host.removeEventListener("pointerenter", play);
      host.removeEventListener("focus", play);
    };
  }, [trigger, play]);

  if (frame === null) {
    return (
      <span ref={rootRef} className={className || undefined}>
        {text}
      </span>
    );
  }
  // While decoding, every character keeps its own box: settled ones show as is, the others turn
  // transparent (so widths and line breaks stay those of the final text) under an aria-hidden glyph.
  const glyphs = Array.from(frame);
  return (
    <span ref={rootRef} data-decoding="" className={className || undefined}>
      {Array.from(text).map((ch, i) =>
        glyphs[i] === ch ? (
          ch
        ) : (
          <span key={i} className="relative">
            <span className="text-transparent">{ch}</span>
            <span
              aria-hidden="true"
              data-decode={glyphs[i]}
              className="pointer-events-none absolute inset-0 text-center leading-[normal] after:content-[attr(data-decode)]"
            />
          </span>
        ),
      )}
    </span>
  );
}
