import { useCallback, useLayoutEffect, useRef, useState } from "react";
import PageThumbnail from "./PageThumbnail";
import { Scissors } from "lucide-react";
import { useT } from "../../i18n";
import { focusRing } from "../../styles/ui";

interface ThumbnailGridProps {
  source: Blob;
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
  const t = useT("split");
  return (
    <button
      onClick={() => onToggle(pageNumber)}
      aria-pressed={isActive}
      className={`group flex w-6 shrink-0 cursor-pointer flex-col items-center justify-center self-stretch ${focusRing} ${
        isActive ? "text-ink" : "text-ink-3 hover:text-ink-2"
      }`}
      title={isActive ? t("removePoint") : t("splitAfter")}
    >
      <div
        className={`w-px flex-1 ${
          isActive
            ? "border-l-2 border-ink"
            : "border-l border-dashed border-line-strong group-hover:border-ink-2"
        }`}
      />
      <Scissors aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 shrink-0 -rotate-90" />
      <div
        className={`w-px flex-1 ${
          isActive
            ? "border-l-2 border-ink"
            : "border-l border-dashed border-line-strong group-hover:border-ink-2"
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
  const t = useT("split");
  const splittable = rowPages.filter(p => p !== numPages);
  if (splittable.length === 0) return null;
  const allActive = splittable.every(p => splitPoints.has(p));
  return (
    <button
      onClick={onCut}
      aria-pressed={allActive}
      className={`ml-2 flex shrink-0 cursor-pointer items-center self-stretch px-1 ${focusRing} ${
        allActive ? "text-ink" : "text-ink-3 hover:text-ink-2"
      }`}
      title={allActive ? t("removeRow") : t("splitRow")}
    >
      <Scissors aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 shrink-0" />
    </button>
  );
}

export default function ThumbnailGrid({
  source,
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
    <>
      <div ref={containerRef} className="flex flex-col gap-y-4">
        {rows.map(rowPages => (
          <div key={rowPages[0]} className="flex items-start">
            {rowPages.map(page => (
              <div key={page} className="flex items-start">
                <div className="w-[280px]">
                  <PageThumbnail source={source} pageNumber={page} />
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
    </>
  );
}
