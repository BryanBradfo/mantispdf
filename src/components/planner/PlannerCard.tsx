import type { ReactNode } from "react";
import type { PlannerItem, PlannerSource } from "../../hooks/usePagePlanner";
import { thumbnailTransform } from "../../lib/rotationTransform";
import PageImage from "../common/PageImage";

interface Props {
  item: PlannerItem;
  source: PlannerSource | undefined;
  /** Caption under the thumbnail, e.g. "report.pdf · 3". */
  label: string;
  /** Visual state for select modes. */
  tone?: "normal" | "removed" | "picked";
  children?: ReactNode;
}

export default function PlannerCard({ item, source, label, tone = "normal", children }: Props) {
  const border =
    tone === "removed" ? "border-red-400 dark:border-red-700"
    : tone === "picked" ? "border-mantis-500 ring-2 ring-mantis-400/60"
    : "border-gray-200 dark:border-[#222]";
  return (
    <div data-testid="planner-card" className={`overflow-hidden rounded-lg border bg-white shadow-sm dark:bg-[#141414] ${border}`}>
      <div className="relative aspect-[8.5/11] w-full overflow-hidden bg-gray-50 dark:bg-[#1a1a1a]">
        {item.kind === "page" && source ? (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ transform: thumbnailTransform(item.rotate), transition: "transform 0.3s ease" }}
          >
            <PageImage source={source.bytes} page={item.page} width={160} alt={label} />
          </div>
        ) : (
          <div className="absolute inset-3 flex items-center justify-center rounded border border-dashed border-gray-300 bg-white text-xs text-gray-400 dark:border-[#333] dark:bg-[#141414] dark:text-[#555]">
            Blank page
          </div>
        )}
        {tone === "removed" && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-500/25 dark:bg-red-900/40">
            <svg className="h-10 w-10 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        )}
        {tone === "picked" && (
          <div className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-mantis-600 text-white shadow" aria-hidden="true">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        {item.kind === "page" && item.rotate !== 0 && (
          <div className="absolute left-1.5 top-1.5 rounded bg-mantis-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{item.rotate}°</div>
        )}
      </div>
      <div className="truncate border-t border-gray-100 px-2 py-1 text-center text-xs text-gray-500 dark:border-[#222] dark:text-[#555]">{label}</div>
      {children}
    </div>
  );
}
