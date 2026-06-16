import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

/** One colored span within a log line. */
interface Segment {
  text: string;
  className?: string;
}

interface LogLine {
  id: string;
  segments: Segment[];
}

interface ParsingTerminalProps {
  /** Filename shown on line 2; falls back to the sample paper. */
  fileName?: string;
  /** Bump this to replay the sequence from the top (e.g. on a new drop). */
  runId?: number;
  className?: string;
}

// Syntax-highlight palette. A terminal is the one place multiple hues read as
// "correct" rather than noisy — info is sky, the extracted artifact is amber,
// success is the brand accent green.
const C = {
  prompt: "text-zinc-600",
  muted: "text-zinc-500",
  text: "text-zinc-300",
  info: "text-sky-300/90",
  file: "text-sky-300",
  latex: "text-amber-300",
  ok: "text-accent",
} as const;

function buildLog(fileName: string): LogLine[] {
  return [
    {
      id: "init",
      segments: [
        { text: "> ", className: C.prompt },
        { text: "Initializing MantisPDF engine...", className: C.info },
      ],
    },
    {
      id: "parse",
      segments: [
        { text: "> ", className: C.prompt },
        { text: "Parsing document: ", className: C.text },
        { text: fileName, className: C.file },
        { text: " (14 pages)", className: C.muted },
      ],
    },
    {
      id: "ocr",
      segments: [
        { text: "> ", className: C.prompt },
        { text: "Detected mathematical block. ", className: C.text },
        { text: "Running deep math OCR...", className: C.info },
      ],
    },
    {
      id: "latex",
      segments: [
        { text: "> ", className: C.prompt },
        { text: "Extracted LaTeX: ", className: C.text },
        {
          text: "\\mathcal{L}_{PINN} = \\mathcal{L}_{data} + \\lambda \\mathcal{L}_{PDE}",
          className: C.latex,
        },
      ],
    },
    {
      id: "done",
      segments: [
        { text: "> ", className: C.prompt },
        { text: "Status: ", className: C.text },
        { text: "Clean Markdown ready.", className: `${C.ok} font-semibold` },
        { text: " (0.84s)", className: C.muted },
      ],
    },
  ];
}

export default function ParsingTerminal({
  fileName = "attention_is_all_you_need.pdf",
  runId = 0,
  className = "",
}: ParsingTerminalProps) {
  const reduceMotion = useReducedMotion();
  const lines = useMemo(() => buildLog(fileName), [fileName]);
  const [visible, setVisible] = useState(0);

  // Reveal lines on a stagger to simulate a live extraction stream. Restart
  // whenever runId or the filename changes; reduced-motion users see it whole.
  useEffect(() => {
    if (reduceMotion) {
      setVisible(lines.length);
      return;
    }
    setVisible(0);
    const timers = lines.map((_, i) =>
      window.setTimeout(() => setVisible(i + 1), 400 + i * 720),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [runId, reduceMotion, lines]);

  const done = visible >= lines.length;

  return (
    <div
      className={`overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl shadow-black/60 ${className}`}
    >
      {/* Window chrome: traffic-light controls left, muted centered path. */}
      <div className="relative flex items-center border-b border-white/10 bg-zinc-900/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 select-none font-mono text-[11px] tracking-tight text-zinc-600">
          ~/mantis-core/extract
        </span>
      </div>

      {/* Log body. */}
      <div className="px-4 py-4 font-mono text-[13px] leading-relaxed sm:px-5 sm:text-sm">
        {lines.map((line, i) => {
          if (i >= visible) return null;
          const isLast = i === visible - 1;
          return (
            <motion.div
              key={line.id}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="whitespace-pre-wrap break-words py-0.5"
            >
              {line.segments.map((seg, j) => (
                <span key={j} className={seg.className}>
                  {seg.text}
                </span>
              ))}
              {isLast && !done && (
                <span className="ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] bg-accent animate-caret-blink" />
              )}
            </motion.div>
          );
        })}
        {done && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
            className="mt-1 flex items-center py-0.5"
          >
            <span className={C.prompt}>{"> "}</span>
            <span className="ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] bg-accent animate-caret-blink" />
          </motion.div>
        )}
      </div>
    </div>
  );
}
