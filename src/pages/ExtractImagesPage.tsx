import { useEffect, useMemo, useRef, useState } from "react";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadAsZip } from "../lib/downloadZip";
import {
  PngCache,
  filterImages,
  imageFileName,
  imageKey,
  imageSize,
  keptWithoutAlphaSummary,
  skippedSummary,
} from "../lib/extractImages";
import type { ExtractResultSpec, ExtractedImage } from "../lib/imageInput";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import LiveSummary from "../components/stamp/LiveSummary";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput } from "./usePdfInput";
import { useDescribeError, useT } from "../i18n";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ImageCard({
  img,
  cache,
  checked,
  onToggle,
}: {
  img: ExtractedImage;
  cache: PngCache;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT("extractImages");
  const tc = useT("common");
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLLabelElement>(null);
  const size = imageSize(img);
  const imgRef = useRef(img);
  imgRef.current = img;
  const cardKey = imageKey(img);

  useEffect(() => {
    let cancelled = false;
    let jpegUrl: string | null = null;
    const load = () => {
      const img = imgRef.current;
      if (img.kind === "jpeg") {
        jpegUrl = URL.createObjectURL(new Blob([img.bytes], { type: "image/jpeg" }));
        setUrl(jpegUrl);
      } else {
        cache.url(img).then(
          (u) => { if (!cancelled) setUrl(u); },
          () => { if (!cancelled) setFailed(true); },
        );
      }
    };
    const el = ref.current;
    let observer: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer?.disconnect();
          load();
        }
      });
      observer.observe(el);
    } else {
      load();
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (jpegUrl) URL.revokeObjectURL(jpegUrl);
    };
  }, [cardKey, cache]);

  return (
    <label
      ref={ref}
      className="flex cursor-pointer flex-col overflow-hidden rounded-lg border border-gray-200 bg-white text-xs dark:border-[#333] dark:bg-[#111]"
    >
      <div className="flex h-32 items-center justify-center bg-gray-100 dark:bg-[#1a1a1a]">
        {url ? (
          <img src={url} alt={imageFileName(img)} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-gray-500 dark:text-[#777]">{failed ? tc("previewUnavailable") : tc("previewLoadingText")}</span>
        )}
      </div>
      <div className="flex items-center gap-2 p-2 text-gray-700 dark:text-[#aaa]">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={t("selectNamed", { name: imageFileName(img) })} />
        <span>
          {size ? t("cardPageSize", { page: img.page, width: size.width, height: size.height }) : t("cardPage", { page: img.page })}
        </span>
      </div>
    </label>
  );
}

export default function ExtractImagesPage() {
  const t = useT("extractImages");
  const tc = useT("common");
  const describe = useDescribeError();
  const worker = usePdfWorker();
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker);
  // Only the skip report is kept from the worker result: holding the whole result would keep every
  // RGBA buffer alive after `images` drops each one once its PNG exists.
  const [skipped, setSkipped] = useState<ExtractResultSpec["skipped"] | null>(null);
  const extracted = skipped !== null;
  const [skipSmall, setSkipSmall] = useState(true);
  const [images, setImages] = useState<ExtractedImage[]>([]);
  const [cache, setCache] = useState<PngCache | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const cacheRef = useRef<PngCache | null>(null);
  const generation = useRef(0);

  /** Drops the current cache and supersedes any download in flight. */
  const discard = () => {
    generation.current++;
    cacheRef.current?.dispose();
    cacheRef.current = null;
    setCache(null);
    setProgress(null);
  };

  // The cache only exists after an extraction, so StrictMode's mount/unmount/mount cannot leave a disposed one.
  useEffect(
    () => () => {
      generation.current++;
      cacheRef.current?.dispose();
    },
    [],
  );

  const visible = useMemo(() => filterImages(images, skipSmall), [images, skipSmall]);
  const chosen = visible.filter((i) => selected.has(imageKey(i)));

  const start = (f: File) => {
    discard();
    setSkipped(null);
    setImages([]);
    void pick(f);
  };

  const extract = () => {
    if (!input || busy) return;
    void run(
      () => worker.extractImages(input.bytes),
      (res) => {
        discard();
        const fresh = new PngCache({
          onConverted: (key) =>
            setImages((cur) =>
              cur.map((i) => (i.kind === "rgba" && imageKey(i) === key ? { ...i, pixels: new Uint8Array(0) } : i)),
            ),
        });
        cacheRef.current = fresh;
        setCache(fresh);
        setSkipped(res.skipped);
        setImages(res.images);
        setSelected(new Set(res.images.map(imageKey)));
      },
    );
  };

  const toggle = (key: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const download = async () => {
    const active = cacheRef.current;
    if (!input || !active || chosen.length === 0 || progress) return;
    const gen = generation.current;
    const stale = () => gen !== generation.current || active.disposed;
    try {
      if (chosen.length === 1) {
        const img = chosen[0];
        const blob =
          img.kind === "jpeg" ? new Blob([img.bytes], { type: "image/jpeg" }) : await active.blob(img);
        if (stale()) return;
        saveBlob(blob, imageFileName(img));
        return;
      }
      const parts: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < chosen.length; i++) {
        if (stale()) return;
        setProgress(t("preparing", { n: i + 1, total: chosen.length }));
        const img = chosen[i];
        const bytes =
          img.kind === "jpeg" ? img.bytes : new Uint8Array(await (await active.blob(img)).arrayBuffer());
        parts.push({ name: imageFileName(img), bytes });
      }
      if (stale()) return;
      await downloadAsZip(parts, baseName(input.file), "images");
    } catch (err) {
      if (!stale()) setError(describe(err));
    } finally {
      if (!stale()) setProgress(null);
    }
  };

  const doReset = () => {
    discard();
    setSkipped(null);
    setImages([]);
    setSelected(new Set());
    reset();
  };

  const skippedText = skipped ? skippedSummary(skipped, t) : "";
  const keptText = skipped ? keptWithoutAlphaSummary(skipped, t) : "";
  // One polite announcement for the whole result, instead of a live region per card.
  const announcement = skipped
    ? [t("found", { count: images.length }), keptText, skippedText].filter(Boolean).join(". ") + "."
    : "";

  return (
    <ToolShell
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/extract-images"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-4" />

      {!input && (
        <div className="mt-8">
          <DropZone onFile={start} error={error} />
        </div>
      )}

      <p className="sr-only" aria-live="polite">{announcement}</p>

      {input && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>

          {!extracted && (
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={extract} disabled={busy} className={`flex-1 ${primaryButton}`}>
                {busy ? t("extracting") : t("extract")}
              </button>
              <button type="button" onClick={doReset} className={secondaryButton}>
                {tc("chooseAnother")}
              </button>
            </div>
          )}

          {extracted && (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-gray-700 dark:text-[#aaa]">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={skipSmall} onChange={(e) => setSkipSmall(e.target.checked)} />
                  {t("skipSmall")}
                </label>
                <div role="group" aria-label={tc("selection")} className="flex gap-4">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setSelected((cur) => new Set([...cur, ...visible.map(imageKey)]))}
                  >
                    {tc("selectAll")}
                  </button>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      const hide = new Set(visible.map(imageKey));
                      setSelected((cur) => new Set([...cur].filter((k) => !hide.has(k))));
                    }}
                  >
                    {tc("selectNone")}
                  </button>
                </div>
              </div>

              {visible.length === 0 ? (
                <p className="mt-4 text-sm text-gray-600 dark:text-[#888]">{t("noImages")}</p>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {cache && visible.map((img) => (
                    <ImageCard
                      key={imageKey(img)}
                      img={img}
                      cache={cache}
                      checked={selected.has(imageKey(img))}
                      onToggle={() => toggle(imageKey(img))}
                    />
                  ))}
                </div>
              )}

              {keptText && <p className="mt-4 text-sm text-gray-600 dark:text-[#888]">{keptText}</p>}
              {skippedText && <p className={`${keptText ? "mt-1" : "mt-4"} text-sm text-gray-600 dark:text-[#888]`}>{skippedText}</p>}
              <LiveSummary
                text={t("selectedOf", { chosen: chosen.length, total: visible.length })}
                className="mt-2 text-sm text-gray-600 dark:text-[#888]"
              />
              <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={() => void download()}
                  disabled={chosen.length === 0 || progress !== null}
                  className={`flex-1 ${primaryButton}`}
                >
                  {progress ?? (chosen.length > 1 ? tc("downloadZip") : tc("download"))}
                </button>
                <button type="button" onClick={doReset} disabled={progress !== null} className={secondaryButton}>
                  {tc("chooseAnother")}
                </button>
              </div>
            </>
          )}

          {!extracted && <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />}
        </div>
      )}
    </ToolShell>
  );
}
