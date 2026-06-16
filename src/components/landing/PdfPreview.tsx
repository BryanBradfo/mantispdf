import { useEffect, useRef, useState } from "react";
import { Loader2, FileWarning } from "lucide-react";
import { Document, Page } from "../../lib/pdf";

interface PdfPreviewProps {
  /** Blob URL of the PDF to render. */
  url: string;
}

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
 */
export default function PdfPreview({ url }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState(0);
  const [width, setWidth] = useState(0);
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
  }, [url]);

  // Container has px-4 (16px) padding each side; cap so huge panels stay sane.
  const pageWidth = width > 0 ? Math.min(width - 32, 1000) : undefined;

  return (
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
          className="flex flex-col items-center gap-4"
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
  );
}
