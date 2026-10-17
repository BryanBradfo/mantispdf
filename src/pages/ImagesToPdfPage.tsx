import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob, errorMessage } from "../lib/fileHelpers";
import {
  BudgetError,
  decodeToRgba,
  isJpeg,
  jpegPassthrough,
  orientationToTransform,
  readJpegFrame,
  readExifOrientation,
  type ImageInputSpec,
  type ImageLayoutSpec,
} from "../lib/imageInput";
import { mmToPt } from "../lib/geometryJob";
import {
  MAX_IMAGES,
  composeTransform,
  imagesPdfName,
  imagesProblem,
  inputBytesProblem,
  layoutSummary,
  marginProblem,
  pixelBudgetProblem,
  sniffImageType,
  totalSizeProblem,
  turn,
  type Quarter,
} from "../lib/imagesToPdf";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import ProgressOverlay from "../components/common/ProgressOverlay";
import SortableGrid from "../components/common/SortableGrid";
import LiveSummary from "../components/stamp/LiveSummary";
import PaperSizeFields, { CUSTOM_PAPER, paperToPt, type PaperChoice } from "../components/geometry/PaperSizeFields";
import { mmSizeLabel } from "../lib/geometryLayout";
import { createUploadQueue } from "./uploadQueue";
import ToolShell, { inputClass, panelClass, primaryButton, secondaryButton } from "./ToolShell";

interface ImageItem {
  id: string;
  file: File;
  /** Extra clockwise rotation chosen on the card. */
  rotate: Quarter;
}

type Orientation = ImageLayoutSpec["orientation"];

let nextId = 0;

/** Object URL for a file, revoked when the file changes or the card unmounts. */
function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

const iconBtn =
  "flex flex-1 items-center justify-center py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#888] dark:hover:bg-[#1a1a1a] dark:hover:text-[#ccc]";

const ImageCard = memo(function ImageCard({
  item,
  index,
  total,
  onRotate,
  onMove,
  onRemove,
  locked,
}: {
  item: ImageItem;
  index: number;
  total: number;
  onRotate: (id: string, dir: -1 | 1) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  locked: boolean;
}) {
  const url = useObjectUrl(item.file);
  return (
    <div
      data-testid="image-card"
      className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-[#222] dark:bg-[#141414]"
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-t-lg bg-gray-50 dark:bg-[#0c0c0c]">
        {url && (
          <img
            src={url}
            alt={item.file.name}
            draggable={false}
            decoding="async"
            loading="lazy"
            className="h-full w-full object-contain transition-transform duration-150"
            style={{ transform: `rotate(${item.rotate}deg)` }}
          />
        )}
        <button
          data-no-dnd
          type="button"
          disabled={locked}
          onClick={() => onRemove(item.id)}
          className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white/80 text-gray-400 shadow-sm hover:bg-red-50 hover:text-red-500 dark:bg-[#1a1a1a]/80 dark:text-[#666] dark:hover:text-red-400"
          title="Remove image"
          aria-label={`Remove ${item.file.name}`}
        >
          ×
        </button>
      </div>
      <div className="border-t border-gray-100 px-2 py-1.5 dark:border-[#222]">
        <p className="truncate text-xs font-medium text-gray-900 dark:text-[#e5e5e5]">
          {index + 1}. {item.file.name}
        </p>
      </div>
      <div className="flex border-t border-gray-100 dark:border-[#222]">
        <button data-no-dnd type="button" className={iconBtn} onClick={() => onMove(index, index - 1)} disabled={locked || index === 0} aria-label={`Move ${item.file.name} earlier`} title="Move earlier">
          ←
        </button>
        <button data-no-dnd type="button" className={iconBtn} disabled={locked} onClick={() => onRotate(item.id, -1)} aria-label={`Rotate ${item.file.name} left`} title="Rotate left">
          ↺
        </button>
        <button data-no-dnd type="button" className={iconBtn} disabled={locked} onClick={() => onRotate(item.id, 1)} aria-label={`Rotate ${item.file.name} right`} title="Rotate right">
          ↻
        </button>
        <button data-no-dnd type="button" className={iconBtn} onClick={() => onMove(index, index + 1)} disabled={locked || index === total - 1} aria-label={`Move ${item.file.name} later`} title="Move later">
          →
        </button>
      </div>
    </div>
  );
});

export default function ImagesToPdfPage() {
  const worker = usePdfWorker();
  const [items, setItems] = useState<ImageItem[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paper, setPaper] = useState<Exclude<PaperChoice, "same">>("A4");
  const [fit, setFit] = useState(false);
  const [customMm, setCustomMm] = useState<[number, number]>([210, 297]);
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [marginMm, setMarginMm] = useState(10);
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState<{ progress: number; message: string }>({ progress: 0, message: "" });
  const genRef = useRef(0);
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Leaving the page mid-build supersedes it: no download after unmount.
  useEffect(
    () => () => {
      genRef.current++;
    },
    [],
  );

  const queue = useMemo(
    () =>
      createUploadQueue<{ images: ImageItem[]; skipped: number }>({
        onResult: ({ images, skipped }) => {
          const skippedNote =
            skipped > 0 ? `${skipped} file${skipped === 1 ? " is" : "s are"} not an image and ${skipped === 1 ? "was" : "were"} skipped.` : "";
          // The room is computed from the latest list; the note is derived from the same pure result.
          setItems((prev) => {
            const room = Math.max(0, MAX_IMAGES - prev.length);
            const over = images.length > room ? `Only the first ${MAX_IMAGES} images were kept.` : "";
            setUploadError([skippedNote, over].filter(Boolean).join(" ") || null);
            return [...prev, ...images.slice(0, room)];
          });
        },
        onError: (err) => setUploadError(errorMessage(err)),
        onPending: () => undefined,
      }),
    [],
  );
  useEffect(() => () => queue.cancel(), [queue]);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (busyRef.current) {
        setUploadError("A PDF is being built. Add more images once it is done.");
        return;
      }
      queue.enqueue(async () => {
        const images: ImageItem[] = [];
        let skipped = 0;
        for (const file of files) {
          let ok = file.type.startsWith("image/");
          if (!ok && file.type === "") {
            ok = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer())) !== null;
          }
          if (ok) images.push({ id: String(++nextId), file, rotate: 0 as Quarter });
          else skipped++;
        }
        return { images, skipped };
      });
    },
    [queue],
  );

  const onRotate = useCallback(
    (id: string, dir: -1 | 1) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, rotate: turn(it.rotate, dir) } : it))),
    [],
  );
  const onMove = useCallback((from: number, to: number) => {
    setItems((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);
  const onRemove = useCallback((id: string) => setItems((prev) => prev.filter((it) => it.id !== id)), []);

  const clear = () => {
    if (busy) return;
    genRef.current++;
    queue.cancel();
    setItems([]);
    setError(null);
    setUploadError(null);
  };

  const pagePt = fit ? "fit" : paperToPt(paper, customMm);
  const problem =
    imagesProblem(items.length, marginMm) ??
    (pagePt === null ? "Enter a custom size between 13 and 5080 mm." : marginProblem(marginMm, pagePt));
  const paperLabel = fit ? "fit to image" : paper === CUSTOM_PAPER ? mmSizeLabel(customMm) : paper;
  const summary = layoutSummary(items.length, paperLabel, fit ? "auto" : orientation, marginMm);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || problem || pagePt === null || items.length === 0) return;
    setError(null);
    setBusy(true);
    const gen = ++genRef.current;
    try {
      // The files alone must fit the engine's input budget: checked before any is read.
      const sizeProblem = totalSizeProblem(items.map((it) => ({ name: it.file.name, size: it.file.size })));
      if (sizeProblem) throw new Error(sizeProblem);
      const specs: ImageInputSpec[] = [];
      // Bytes handed to the engine so far: JPEG files plus 4 per decoded pixel.
      let usedBytes = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const name = it.file.name;
        // 1-based, as numbered on the cards.
        const label = `Image ${i + 1} (${name})`;
        setPrep({ progress: (i / items.length) * 0.8, message: `Reading image ${i + 1} of ${items.length}…` });
        let passthrough = false;
        if (isJpeg(new Uint8Array(await it.file.slice(0, 3).arrayBuffer()))) {
          const tooMuch = inputBytesProblem(name, it.file.size, usedBytes);
          if (tooMuch) throw new Error(tooMuch);
          const bytes = new Uint8Array(await it.file.arrayBuffer());
          const frame = readJpegFrame(bytes);
          const tooBig = frame && pixelBudgetProblem(label, frame.width, frame.height);
          if (tooBig) throw new Error(tooBig);
          // 12-bit, lossless and arithmetic-coded JPEGs are decoded below instead.
          if (jpegPassthrough(bytes)) {
            const t = composeTransform(orientationToTransform(readExifOrientation(bytes)), it.rotate);
            usedBytes += bytes.length;
            specs.push({ kind: "jpeg", bytes, rotate: t.rotate, flipX: t.flipX });
            passthrough = true;
          }
        }
        if (!passthrough) {
          let decoded: Awaited<ReturnType<typeof decodeToRgba>>;
          try {
            // Refused before the pixel buffer is allocated.
            decoded = await decodeToRgba(
              it.file,
              (w, h) => pixelBudgetProblem(label, w, h) ?? inputBytesProblem(name, w * h * 4, usedBytes),
            );
          } catch (err) {
            if (err instanceof BudgetError) throw err;
            throw new Error(`Could not read ${name}: ${errorMessage(err)}`);
          }
          const { width, height, pixels } = decoded;
          const t = composeTransform({ rotate: 0, flipX: false }, it.rotate);
          usedBytes += pixels.length;
          specs.push({ kind: "rgba", width, height, pixels, rotate: t.rotate, flipX: t.flipX });
        }
        if (gen !== genRef.current) return;
      }
      setPrep({ progress: 0.9, message: "Building PDF…" });
      const layout: ImageLayoutSpec = { page: pagePt, orientation: fit ? "auto" : orientation, margin: mmToPt(marginMm) };
      const out = await worker.imagesToPdf(specs, layout);
      if (gen !== genRef.current) return;
      downloadBlob(out, imagesPdfName(items.map((it) => it.file.name)));
    } catch (err) {
      if (gen === genRef.current) setError(errorMessage(err));
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  };

  return (
    <ToolShell
      title="Images to PDF: JPG, PNG, WebP to PDF | MantisPDF"
      description="Turn images into a PDF, one per page. Reorder, rotate, pick a page size. Free, private, nothing is uploaded."
      path="/images-to-pdf"
      heading="Images to PDF"
      intro="Put JPG, PNG or WebP images on PDF pages. JPEGs are embedded without re-encoding. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      <div className="mt-8">
        <DropZone multiple onFiles={handleFiles} error={uploadError} accept="image/*" noun="image" hint="JPG, PNG, WebP, GIF, BMP" />
      </div>

      {items.length > 0 && (
        <form className={panelClass} onSubmit={(e) => void submit(e)}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
            {items.length} image{items.length === 1 ? "" : "s"}. Grab a card to reorder.
          </p>
          <div className="mt-4">
            <SortableGrid
              items={items}
              onReorder={(f, t) => { if (!busy) onMove(f, t); }}
              label={(it) => it.file.name}
              className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3"
              renderItem={(it, index) => (
                <ImageCard item={it} index={index} total={items.length} onRotate={onRotate} onMove={onMove} onRemove={onRemove} locked={busy} />
              )}
            />
          </div>

          <div className="mt-6 space-y-4">
            <PaperSizeFields paper={paper} onPaper={(p) => { if (p !== "same") setPaper(p); }} customMm={customMm} onCustomMm={setCustomMm} fit={fit} onFit={setFit} />
            {!fit && (
              <label className="block text-sm text-gray-700 dark:text-[#aaa]">
                Orientation
                <select value={orientation} onChange={(e) => setOrientation(e.target.value as Orientation)} className={inputClass}>
                  <option value="auto">Auto (match each image)</option>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
            )}
            <label className="block text-sm text-gray-700 dark:text-[#aaa]">
              Margin (mm)
              <input type="number" min={0} max={200} value={Number.isFinite(marginMm) ? marginMm : ""}
                onChange={(e) => setMarginMm(e.target.value === "" ? NaN : Number(e.target.value))} className={inputClass} />
            </label>
          </div>

          <LiveSummary text={summary} className="mt-4 text-sm text-gray-600 dark:text-[#888]" />
          <ErrorAlert error={problem} className="mt-4" />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
          <div className="mt-6 flex gap-3">
            <button type="submit" disabled={busy || problem !== null || !worker.ready} className={`flex-1 ${primaryButton}`}>
              {busy ? "Building…" : "Create PDF"}
            </button>
            <button type="button" disabled={busy} onClick={clear} className={secondaryButton}>Clear all</button>
          </div>
        </form>
      )}

      {busy && (
        <ProgressOverlay progress={prep.progress} message={prep.message} error={null} onDismissError={() => undefined} />
      )}
    </ToolShell>
  );
}
