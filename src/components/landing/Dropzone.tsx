import { useCallback, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { FileText, UploadCloud, CheckCircle2 } from "lucide-react";

interface DropzoneProps {
  /** Called with the first accepted PDF (from drop or file picker). */
  onFile?: (file: File) => void;
  /** Name of the most recently accepted file, shown as a confirmation chip. */
  acceptedName?: string | null;
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

export default function Dropzone({ onFile, acceptedName }: DropzoneProps) {
  const reduceMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Drag events fire per descendant element; a depth counter keeps the active
  // state from flickering as the pointer crosses child nodes.
  const dragDepth = useRef(0);

  const accept = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const pdf = Array.from(files).find(isPdf);
      if (pdf) onFile?.(pdf);
    },
    [onFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      accept(e.dataTransfer.files);
    },
    [accept],
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const active = dragging;

  return (
    <div className="relative">
      {/* Outer glow layer — intensifies on drag-over. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -inset-2 rounded-[1.4rem] transition-opacity duration-300 ${
          active ? "opacity-100" : "opacity-0"
        }`}
        style={{
          background:
            "radial-gradient(60% 60% at 50% 50%, rgba(124,252,77,0.22), rgba(124,252,77,0) 70%)",
        }}
      />

      <motion.div
        role="button"
        tabIndex={0}
        aria-label="Upload a PDF to extract Markdown and LaTeX"
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={onDrop}
        animate={
          reduceMotion ? undefined : { scale: active ? 1.01 : 1 }
        }
        transition={{ type: "spring", stiffness: 300, damping: 24 }}
        className={`group relative flex cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-6 py-12 text-center outline-none transition-colors duration-300 sm:py-14 ${
          active
            ? "border-accent bg-accent/[0.06] shadow-glow-lg dark:bg-accent/[0.04]"
            : "border-zinc-300 bg-white/60 hover:border-zinc-400 focus-visible:border-accent/70 dark:border-white/10 dark:bg-white/[0.02] dark:hover:border-white/20"
        }`}
      >
        {/* Icon badge */}
        <motion.div
          animate={reduceMotion ? undefined : { y: active ? -4 : 0 }}
          transition={{ type: "spring", stiffness: 250, damping: 18 }}
          className={`relative flex h-14 w-14 items-center justify-center rounded-xl border transition-colors duration-300 ${
            active
              ? "border-accent/40 bg-accent/10 text-accent-deep dark:text-accent"
              : "border-zinc-200 bg-white text-zinc-500 group-hover:text-zinc-900 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300 dark:group-hover:text-white"
          }`}
        >
          {active ? (
            <UploadCloud className="h-7 w-7" strokeWidth={1.5} />
          ) : (
            <FileText className="h-7 w-7" strokeWidth={1.5} />
          )}
        </motion.div>

        <div>
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 sm:text-xl">
            Drop research papers here, get perfect Markdown.
          </p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500">
            Drag &amp; drop a PDF, or{" "}
            <span className="font-medium text-accent-deep dark:text-accent">browse your files</span>.
            Everything runs locally.
          </p>
        </div>

        {acceptedName && (
          <span className="inline-flex max-w-full items-center gap-2 truncate rounded-full border border-accent/30 bg-accent/10 px-3 py-1 font-mono text-xs text-accent">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{acceptedName}</span>
          </span>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => accept(e.target.files)}
        />
      </motion.div>
    </div>
  );
}
