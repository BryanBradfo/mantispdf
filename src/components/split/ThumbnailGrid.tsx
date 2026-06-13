import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Document } from "react-pdf";
import PageThumbnail from "./PageThumbnail";

interface ThumbnailGridProps {
  pdfUrl: string;
  numPages: number;
  splitPoints: Set<number>;
  onToggleSplit: (page: number) => void;
}

function VerticalDivider({
  pageNumber,
  isActive,
  onToggle,
}: {
  pageNumber: number;
  isActive: boolean;
  onToggle: (page: number) => void;
}) {
  return (
    <button
      onClick={() => onToggle(pageNumber)}
      className={`group flex w-6 shrink-0 cursor-pointer flex-col items-center justify-center self-stretch transition ${
        isActive ? "text-mantis-600" : "text-gray-300 hover:text-gray-500 dark:text-[#333] dark:hover:text-[#666]"
      }`}
      title={isActive ? "Remove split point" : "Split after this page"}
    >
      <div
        className={`w-px flex-1 transition ${
          isActive
            ? "border-l-2 border-dashed border-mantis-400"
            : "border-l border-dashed border-gray-200 group-hover:border-gray-400 dark:border-[#222] dark:group-hover:border-[#444]"
        }`}
      />
      <svg
        className="h-5 w-5 shrink-0 rotate-90"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64a4 4 0 1 0-8 0 4 4 0 0 0 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A4.2 4.2 0 0 0 6 14a4 4 0 1 0 4 4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64M6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4m0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4M19 3l-3 3 1.5 1.5L22 3h-3Z" />
      </svg>
      <div
        className={`w-px flex-1 transition ${
          isActive
            ? "border-l-2 border-dashed border-mantis-400"
            : "border-l border-dashed border-gray-200 group-hover:border-gray-400 dark:border-[#222] dark:group-hover:border-[#444]"
        }`}
      />
    </button>
  );
}

function RowEndCut({
  rowPages,
  numPages,
  splitPoints,
  onCut,
}: {
  rowPages: number[];
  numPages: number;
  splitPoints: Set<number>;
  onCut: () => void;
}) {
  const splittable = rowPages.filter(p => p !== numPages);
  if (splittable.length === 0) return null;
  const allActive = splittable.every(p => splitPoints.has(p));
  return (
    <button
      onClick={onCut}
      className={`ml-2 flex shrink-0 cursor-pointer items-center self-stretch px-1 transition ${
        allActive
          ? "text-mantis-600"
          : "text-gray-300 hover:text-gray-500 dark:text-[#333] dark:hover:text-[#666]"
      }`}
      title={allActive ? "Remove all splits in this row" : "Split after every page in this row"}
    >
      <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9.64 7.64c.23-.5.36-1.05.36-1.64a4 4 0 1 0-8 0 4 4 0 0 0 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A4.2 4.2 0 0 0 6 14a4 4 0 1 0 4 4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64M6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4m0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4M19 3l-3 3 1.5 1.5L22 3h-3Z" />
      </svg>
    </button>
  );
}

export default function ThumbnailGrid({
  pdfUrl,
  numPages,
  splitPoints,
  onToggleSplit,
}: ThumbnailGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Read immediately so the first paint uses the correct column count.
    setContainerWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Each page slot = 280px thumbnail + 24px divider = 304px.
  // Last column has no trailing divider, so add 24px back before dividing.
  const numCols = containerWidth > 0
    ? Math.max(1, Math.floor((containerWidth + 24) / 304))
    : 4;

  const rows: number[][] = [];
  for (let i = 0; i < numPages; i += numCols) {
    rows.push(Array.from({ length: Math.min(numCols, numPages - i) }, (_, j) => i + j + 1));
  }

  const handleRowCut = useCallback(
    (rowPages: number[]) => {
      const splittable = rowPages.filter(p => p !== numPages);
      const allActive = splittable.every(p => splitPoints.has(p));
      if (allActive) {
        splittable.forEach(p => onToggleSplit(p));
      } else {
        splittable.filter(p => !splitPoints.has(p)).forEach(p => onToggleSplit(p));
      }
    },
    [numPages, splitPoints, onToggleSplit],
  );

  return (
    <Document file={pdfUrl} loading={null}>
      <div ref={containerRef} className="flex flex-col gap-y-4">
        {rows.map(rowPages => (
          <div key={rowPages[0]} className="flex items-start">
            {rowPages.map(page => (
              <div key={page} className="flex items-start">
                <div className="w-[280px]">
                  <PageThumbnail pageNumber={page} />
                </div>
                {page !== numPages && (
                  <VerticalDivider
                    pageNumber={page}
                    isActive={splitPoints.has(page)}
                    onToggle={onToggleSplit}
                  />
                )}
              </div>
            ))}
            <RowEndCut
              rowPages={rowPages}
              numPages={numPages}
              splitPoints={splitPoints}
              onCut={() => handleRowCut(rowPages)}
            />
          </div>
        ))}
      </div>
    </Document>
  );
}
