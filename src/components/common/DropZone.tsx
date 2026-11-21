import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Trans, useT, type UiError } from "../../i18n";
import { FileUp } from "lucide-react";
import ErrorText from "./ErrorText";
import PixelIcon from "../brand/PixelIcon";
import PageDropOverlay from "./PageDropOverlay";
import { PAGE_ICONS } from "../../lib/pixelIcons";
import {
  pageDragActive,
  pageDropLeader,
  pageHasSeveralDropTargets,
  registerPageDropTarget,
  subscribePageDrop,
  type PageDropTarget,
} from "./pageDrop";
import { primaryButtonLarge } from "../../styles/ui";

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
  /** The tool's real size limit in MB, shown in the default PDF hint ("PDF files · up to 64 MB"). */
  maxMb?: number;
  /**
   * The PDF engine can take the file now. Exposed as `data-engine-ready="true"` on the file input
   * (tests wait for it instead of retrying the upload); undefined when the page does not say.
   * `false` also turns off drop-anywhere on the page until it is ready.
   */
  engineReady?: boolean;
  /** A slim one-line frame, for adding more files once some are loaded. */
  compact?: boolean;
}

/** The home's white primary button, drawn on a span (the zone is the one control); paper on ink while dragging. */
const buttonFace = (dragging: boolean) => `${primaryButtonLarge(dragging)} pointer-events-none group-hover:opacity-85`;

export default function DropZone({
  onFile,
  onFiles,
  multiple,
  error,
  accept = ".pdf,application/pdf",
  kind = "pdf",
  hint,
  maxMb,
  engineReady,
  compact = false,
}: DropZoneProps) {
  const t = useT("common");
  const [over, setOver] = useState(false);
  const labelRef = useRef<HTMLLabelElement>(null);

  const deliver = useCallback(
    (files: File[]) => {
      if (multiple && onFiles) {
        if (files.length > 0) onFiles(files);
      } else if (onFile) {
        const file = files[0];
        if (file) onFile(file);
      }
    },
    [onFile, onFiles, multiple],
  );

  // Drop anywhere: register while enabled; the first zone on the page shows the overlay.
  const deliverRef = useRef(deliver);
  useEffect(() => {
    deliverRef.current = deliver;
  }, [deliver]);
  const [target] = useState<PageDropTarget>(() => ({ el: null, deliver: (files) => deliverRef.current(files) }));
  const enabled = engineReady !== false;
  useEffect(() => {
    if (!enabled) return;
    target.el = labelRef.current;
    return registerPageDropTarget(target);
  }, [enabled, target]);
  const leads = useSyncExternalStore(subscribePageDrop, () => pageDropLeader() === target, () => false);
  const several = useSyncExternalStore(subscribePageDrop, pageHasSeveralDropTargets, () => false);
  const pageDrag = useSyncExternalStore(subscribePageDrop, pageDragActive, () => false);
  // Files over this zone, or (several zones, no overlay) files anywhere over the page: show it as a target.
  const dragging = over || (enabled && several && pageDrag);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      deliver(Array.from(e.dataTransfer.files));
    },
    [deliver],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      deliver(Array.from(e.target.files ?? []));
      // Reset so the same file(s) can be re-selected
      e.target.value = "";
    },
    [deliver],
  );

  const image = kind === "image";
  const hintText = hint ?? (maxMb ? t("dropHintPdfMax", { max: maxMb }) : t("dropHintPdf"));

  return (
    <div>
      <label
        ref={labelRef}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
        data-dragging={dragging ? "true" : undefined}
        className={`group flex cursor-pointer items-center justify-center border border-dashed px-6 text-center has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-paper ${
          compact ? "flex-wrap gap-x-4 gap-y-1 py-5" : "min-h-[220px] flex-col py-10 sm:min-h-[320px]"
        } ${
          dragging ? "border-ink bg-ink text-paper" : "border-line-strong bg-paper text-ink hover:border-ink"
        }`}
      >
        {compact ? (
          <>
            <FileUp aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
            <p className="text-sm">
              <Trans
                ns="common"
                k={image ? (multiple ? "dropImages" : "dropImage") : multiple ? "dropPdfs" : "dropPdf"}
                components={{ browse: (c) => <span className="underline decoration-1 underline-offset-4">{c}</span> }}
              />
            </p>
          </>
        ) : (
          <>
            <PixelIcon icon={PAGE_ICONS.fileUp} className="mb-6 h-12 w-12 sm:h-16 sm:w-16" />
            <span data-testid="drop-button" className={buttonFace(dragging)}>
              {t(image ? (multiple ? "dropChooseImages" : "dropChooseImage") : multiple ? "dropChoosePdfs" : "dropChoosePdf")}
            </span>
            <span className={`mt-3 block text-sm ${dragging ? "text-paper" : "text-ink-2"}`}>
              {t(multiple ? "dropOrMany" : image ? "dropOrImage" : "dropOrPdf")}
            </span>
          </>
        )}
        <p className={`${compact ? "" : "mt-5 "}font-mono text-[11px] uppercase tracking-[0.08em] ${dragging ? "text-paper" : "text-ink-2"}`}>
          {hintText}
        </p>
        <input
          data-engine-ready={engineReady ? "true" : undefined}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleChange}
          onKeyDown={(e) => {
            // Space opens the picker natively; make Enter do the same in every browser.
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
          className="sr-only"
        />
      </label>
      {leads && <PageDropOverlay onFiles={deliver} overlay={!several} />}
      {error && (
        <div className="mt-3 text-center text-sm font-medium text-danger">
          <ErrorText error={error} />
        </div>
      )}
    </div>
  );
}
