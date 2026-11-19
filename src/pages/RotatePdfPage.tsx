import { useCallback, useRef, useState } from "react";
import { Link, useDescribeError, useT, type UiError } from "../i18n";
import { RotateCcw, RotateCw } from "lucide-react";
import ToolShell from "./ToolShell";
import LoadingRow from "../components/common/LoadingRow";
import { cellButton, fileMeta, primaryButton, secondaryButton } from "../styles/ui";
import PageImage from "../components/common/PageImage";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { isPdfFile, downloadBlob, readFileAsUint8Array } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import { thumbnailTransform } from "../lib/rotationTransform";

export default function RotatePdfPage() {
  const worker = usePdfWorker();

  const [file, setFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [rotations, setRotations] = useState<number[]>([]);
  const t = useT("rotate");
  const tc = useT("common");
  const describe = useDescribeError();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<UiError | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [loading, setLoading] = useState(false);
  // Identifies the latest upload so a superseded countPages result is ignored.
  const uploadToken = useRef(0);

  const handleFile = useCallback(
    async (f: File) => {
      if (!isPdfFile(f)) {
        setUploadError(tc("invalidPdf"));
        return;
      }
      if (!worker.ready) {
        setUploadError(worker.initError ? tc("engineFailedReload") : tc("engineLoading"));
        return;
      }
      const token = ++uploadToken.current;
      setUploadError(null);
      setRotateError(null);
      setLoading(true);
      try {
        const n = await worker.countPages(await readFileAsUint8Array(f));
        if (token !== uploadToken.current) return;
        if (n <= 0) {
          setUploadError(tc("readFailed"));
        } else {
          setFile(f);
          setNumPages(n);
          setRotations(Array(n).fill(0));
        }
      } catch {
        if (token === uploadToken.current) setUploadError(tc("readFailed"));
      } finally {
        if (token === uploadToken.current) setLoading(false);
      }
    },
    [worker, tc],
  );

  const rotatePage = useCallback((idx: number, delta: number) => {
    setRotations((r) => r.map((v, i) => (i === idx ? ((v + delta + 360) % 360) : v)));
  }, []);

  const rotateAll = useCallback((delta: number) => {
    setRotations((r) => r.map((v) => (v + delta + 360) % 360));
  }, []);

  const handleDownload = useCallback(async () => {
    if (!file || rotations.length === 0) return;
    setRotateError(null);
    try {
      const result = await worker.rotatePdf(file, rotations);
      const outName = file.name.replace(/\.pdf$/i, "") + "_rotated.pdf";
      downloadBlob(new Uint8Array(result), outName);
      setDownloaded(true);
    } catch (err) {
      setRotateError(describe(err));
    }
  }, [file, rotations, worker, describe]);

  const handleReset = useCallback(() => {
    setFile(null);
    setNumPages(0);
    setRotations([]);
    setRotateError(null);
    setDownloaded(false);
  }, []);

  const allZero = rotations.every((v) => v === 0);

  return (
    <ToolShell
      tool="rotate"
      wide
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/rotate"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-6" />

      {!file ? (
        loading ? (
          <LoadingRow label={tc("loadingPdf")} className="mt-8 justify-center py-12" />
        ) : (
          <div className="mt-8">
            <DropZone onFile={handleFile} error={uploadError} />
          </div>
        )
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <p className={fileMeta}>
              {tc("fileWithPages", { name: file.name, count: numPages })}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => rotateAll(-90)}
                disabled={numPages === 0}
                aria-label={t("allCcwLabel")}
                className={secondaryButton}
              >
                {t("allCcw")}
              </button>
              <button
                onClick={() => rotateAll(90)}
                disabled={numPages === 0}
                aria-label={t("allCwLabel")}
                className={secondaryButton}
              >
                {t("allCw")}
              </button>
              <button
                onClick={() => setRotations(Array(numPages).fill(0))}
                disabled={allZero || numPages === 0}
                className={secondaryButton}
              >
                {t("resetAll")}
              </button>
              <button
                onClick={handleDownload}
                disabled={worker.rotating || !worker.ready || numPages === 0}
                className={primaryButton}
              >
                {worker.rotating ? tc("processing") : tc("download")}
              </button>
              {downloaded && (
                <Link to="/" className={secondaryButton}>
                  {tc("allTools")}
                </Link>
              )}
              <button onClick={handleReset} className={secondaryButton}>
                {tc("newFile")}
              </button>
            </div>
          </div>

          <ErrorAlert error={rotateError} onDismiss={() => setRotateError(null)} className="mt-4" />

          <div className="mt-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i} className="border border-line bg-surface">
                  <div className="relative aspect-[8.5/11] w-full overflow-hidden bg-surface">
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{
                        transform: thumbnailTransform(rotations[i] ?? 0),
                        transition: "transform 150ms ease",
                      }}
                    >
                      <PageImage source={file!} page={i + 1} width={160} alt={tc("pageN", { n: i + 1 })} />
                    </div>
                    {rotations[i] !== 0 && (
                      <div className="absolute right-1.5 top-1.5 bg-ink px-1.5 py-0.5 font-mono text-[11px] text-paper">
                        {rotations[i]}°
                      </div>
                    )}
                  </div>
                  <div className="border-t border-line px-2 py-1.5 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
                    {tc("pageN", { n: i + 1 })}
                  </div>
                  <div className="flex h-9 divide-x divide-line border-t border-line">
                    <button
                      onClick={() => rotatePage(i, -90)}
                      className={cellButton}
                      title={t("ccw")}
                      aria-label={t("ccwPage", { n: i + 1 })}
                    >
                      <RotateCcw aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => rotatePage(i, 90)}
                      className={cellButton}
                      title={t("cw")}
                      aria-label={t("cwPage", { n: i + 1 })}
                    >
                      <RotateCw aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </ToolShell>
  );
}
