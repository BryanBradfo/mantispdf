import { useEffect, useRef, useState } from "react";
import { Loader2, FileWarning, ZoomIn, ZoomOut } from "lucide-react";
import { Document, Page } from "../../lib/pdf";

interface PdfPreviewProps {
  /** Blob URL of the PDF to render. */
  url: string;
}

// Zoom bounds for the viewer. 1 = "fit panel width" (the default). Below 1 the
// pages shrink and stay centered; above 1 they overflow and the panel scrolls.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

/**
 * Continuous, read-only PDF viewer for the Workspace's left panel. Renders
 * white pages on a dark canvas (Preview/Acrobat style) via react-pdf, sized to
 * the container width so pages stay crisp and fill the panel. Text and
 * annotation layers are disabled — this is a preview, so an image per page is
 * lighter and avoids the layer CSS.
 *
 * A floating zoom control multiplies the fit-width by a zoom factor; react-pdf
 * re-renders each page's canvas at the new size, so text stays sharp at any
 * zoom (unlike a CSS transform, which would blur).
 */
export default function PdfPreview({ url }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [errored, setErrored] = useState(false);

  // Track the container width so each Page renders at the panel size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset when a different document is loaded.
  useEffect(() => {
    setNumPages(0);
    setErrored(false);
    setZoom(1);
  }, [url]);

  // Container has px-4 (16px) padding each side; cap so huge panels stay sane.
  const fitWidth = width > 0 ? Math.min(width - 32, 1000) : undefined;
  const pageWidth =
    fitWidth !== undefined ? Math.round(fitWidth * zoom) : undefined;

  const zoomOut = () =>
    setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
  const zoomIn = () =>
    setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const resetZoom = () => setZoom(1);

  const showControls = numPages > 0 && !errored;

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        className="h-full overflow-auto bg-zinc-100 px-4 py-4 dark:bg-black/50"
      >
        {errored ? (
          <Centered>
            <FileWarning className="h-7 w-7 text-zinc-400 dark:text-zinc-600" strokeWidth={1.5} />
            <p>Couldn&apos;t render this PDF.</p>
          </Centered>
        ) : (
          <Document
            file={url}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={() => setErrored(true)}
            loading={
              <Centered>
                <Loader2 className="h-7 w-7 animate-spin text-accent-deep dark:text-accent" />
                <p>Loading document…</p>
              </Centered>
            }
            error={
              <Centered>
                <FileWarning className="h-7 w-7 text-zinc-400 dark:text-zinc-600" strokeWidth={1.5} />
                <p>Couldn&apos;t render this PDF.</p>
              </Centered>
            }
            // w-max + mx-auto: the column sizes to the widest page so horizontal
            // scroll reaches the whole page when zoomed in, and stays centered
            // when the page is narrower than the panel.
            className="mx-auto flex w-max flex-col items-center gap-4"
          >
            {pageWidth !== undefined &&
              Array.from({ length: numPages }, (_, i) => (
                <Page
                  key={i}
                  pageNumber={i + 1}
                  width={pageWidth}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  className="overflow-hidden rounded-lg shadow-lg shadow-black/20 ring-1 ring-black/5 dark:shadow-black/50 dark:ring-white/10"
                  loading={
                    <div
                      className="rounded-lg bg-zinc-200 dark:bg-zinc-900"
                      style={{ width: pageWidth, height: pageWidth * 1.3 }}
                    />
                  }
                />
              ))}
          </Document>
        )}
      </div>

      {showControls && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-zinc-900/85 px-1.5 py-1 text-zinc-100 shadow-lg ring-1 ring-white/10 backdrop-blur dark:bg-black/80">
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              aria-label="Zoom out"
              className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ZoomOut className="h-4 w-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={resetZoom}
              aria-label="Reset zoom to fit width"
              className="min-w-[3.25rem] rounded-full px-2 py-1 text-xs font-medium tabular-nums transition hover:bg-white/10"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              aria-label="Zoom in"
              className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ZoomIn className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
