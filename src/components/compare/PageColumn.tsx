import { memo, type RefObject } from "react";
import { useT } from "../../i18n";
import PageImage from "../common/PageImage";
import type { Mark, Size } from "../../lib/compare/view";
import { COMPARE_ACTIVE, COMPARE_ADDED, COMPARE_REMOVED, COMPARE_STRIKE, COMPARE_SWATCH_PAGE } from "../../styles/onPage";
import { focusRing, monoLabel } from "../../styles/ui";

/** Render width of the page images (CSS pixels at 2x for a ~400 px column). */
const RENDER_WIDTH = 800;

interface Props {
  label: string;
  /** Shown after the label from the sm breakpoint (phones keep the short label). */
  fileName: string;
  /** Accessible name of the scrolling region. */
  regionLabel: string;
  source: Blob;
  sizes: readonly Size[];
  /** Highlights per page (`marks[i]` on page i). */
  marks: readonly Mark[][];
  active: number | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Filled with the page boxes, in page order (for the scroll sync). */
  pageRefs: RefObject<(HTMLDivElement | null)[]>;
  onScroll: () => void;
  testId: string;
}

const pct = (v: number) => `${v * 100}%`;

/** One highlight, positioned in percent of the page so it follows the rendered size. */
function MarkBox({ mark, size, active }: { mark: Mark; size: Size; active: boolean }) {
  const [w, h] = size;
  const { x, y, w: bw, h: bh } = mark.box;
  const style = {
    left: pct(x / w),
    top: pct((h - y - bh) / h),
    width: pct(bw / w),
    height: pct(bh / h),
    ...(mark.kind === "removed" ? COMPARE_REMOVED : COMPARE_ADDED),
    ...(active ? COMPARE_ACTIVE : {}),
  };
  return (
    <div data-mark={mark.kind} data-change={mark.change} data-active={active ? "true" : undefined} className="absolute" style={style}>
      {mark.kind === "removed" && <div className="absolute inset-x-0 top-[56%] h-[1.5px]" style={COMPARE_STRIKE} />}
    </div>
  );
}

/** A column of page renders with the comparison highlights over them, scrolling on its own. */
function PageColumn({ label, fileName, regionLabel, source, sizes, marks, active, scrollRef, pageRefs, onScroll, testId }: Props) {
  const tc = useT("common");
  return (
    <div className="flex min-w-0 flex-col">
      <p className={`${monoLabel} mb-2 truncate`}>
        {label}
        <span className="hidden sm:inline"> · {fileName}</span>
      </p>
      <div
        ref={scrollRef}
        role="region"
        aria-label={regionLabel}
        tabIndex={0}
        data-testid={testId}
        onScroll={onScroll}
        className={`relative h-[62vh] overflow-y-auto overscroll-contain border border-line bg-surface p-2 sm:h-[74vh] sm:p-4 ${focusRing}`}
      >
        {sizes.map((size, i) => {
          const [w, h] = size;
          const ok = w > 0 && h > 0;
          return (
            <figure key={i} className={i > 0 ? "mt-3 sm:mt-5" : ""}>
              <div
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                data-page={i + 1}
                className="relative w-full overflow-hidden outline outline-1 outline-line"
                // A white page while the render loads, so the marks (drawn for a white page) are always visible.
                style={{ ...COMPARE_SWATCH_PAGE, aspectRatio: ok ? `${w} / ${h}` : "8.5 / 11" }}
              >
                <PageImage source={source} page={i + 1} width={RENDER_WIDTH} alt={tc("pageN", { n: i + 1 })} className="!absolute inset-0 !aspect-auto h-full !bg-transparent" />
                {ok && (
                  <div className="pointer-events-none absolute inset-0">
                    {(marks[i] ?? []).map((m, k) => (
                      <MarkBox key={k} mark={m} size={size} active={m.change === active} />
                    ))}
                  </div>
                )}
              </div>
              <figcaption aria-hidden="true" className={`${monoLabel} mt-1.5 text-center`}>{i + 1}</figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

export default memo(PageColumn);
