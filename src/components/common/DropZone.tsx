import { useCallback, useState } from "react";
import { Trans, useT, type UiError } from "../../i18n";
import { FileUp } from "lucide-react";
import ErrorText from "./ErrorText";

interface DropZoneProps {
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
  multiple?: boolean;
  error: UiError | null;
  /** File input accept filter; defaults to PDFs. */
  accept?: string;
  /** What the prompt asks for (default PDFs); `hint` overrides the line under it ("PDF files"). */
  kind?: "pdf" | "image";
  hint?: string;
  /**
   * The PDF engine can take the file now. Exposed as `data-engine-ready="true"` on the file input
   * (tests wait for it instead of retrying the upload); undefined when the page does not say.
   */
  engineReady?: boolean;
  /** A slim one-line frame, for adding more files once some are loaded. */
  compact?: boolean;
}

export default function DropZone({ onFile, onFiles, multiple, error, accept = ".pdf,application/pdf", kind = "pdf", hint, engineReady, compact = false }: DropZoneProps) {
  const t = useT("common");
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (multiple && onFiles) {
        if (files.length > 0) onFiles(files);
      } else if (onFile) {
        const file = files[0];
        if (file) onFile(file);
      }
    },
    [onFile, onFiles, multiple],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (multiple && onFiles) {
        if (files.length > 0) onFiles(files);
      } else if (onFile) {
        const file = files[0];
        if (file) onFile(file);
      }
      // Reset so the same file(s) can be re-selected
      e.target.value = "";
    },
    [onFile, onFiles, multiple],
  );

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        data-dragging={dragging ? "true" : undefined}
        className={`group flex cursor-pointer items-center justify-center border border-dashed px-6 text-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-paper ${
          compact ? "flex-wrap gap-x-4 gap-y-1 py-5" : "flex-col py-12 sm:py-16"
        } ${
          dragging ? "border-ink bg-ink text-paper" : "border-line-strong bg-paper text-ink hover:border-ink"
        }`}
      >
        <FileUp aria-hidden="true" strokeWidth={1.5} className={compact ? "h-5 w-5" : "mb-4 h-9 w-9"} />
        <p className={compact ? "text-sm" : "text-base sm:text-lg"}>
          <Trans
            ns="common"
            k={kind === "image" ? (multiple ? "dropImages" : "dropImage") : multiple ? "dropPdfs" : "dropPdf"}
            components={{ browse: (c) => <span className="underline decoration-1 underline-offset-4">{c}</span> }}
          />
        </p>
        <p className={`${compact ? "" : "mt-3 "}font-mono text-[11px] uppercase tracking-[0.08em] ${dragging ? "text-paper" : "text-ink-2"}`}>
          {hint ?? t("dropHintPdf")}
        </p>
        <input
          data-engine-ready={engineReady ? "true" : undefined}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          className="sr-only"
        />
      </label>
      {error && (
        <div className="mt-3 text-center text-sm font-medium text-danger">
          <ErrorText error={error} />
        </div>
      )}
    </div>
  );
}
