import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import type { PlannerItem, PlannerSource } from "../../hooks/usePagePlanner";
import { thumbnailTransform } from "../../lib/rotationTransform";
import PageImage from "../common/PageImage";
import { useT } from "../../i18n";
import { selectedOutline } from "../../styles/ui";

interface Props {
  item: PlannerItem;
  source: PlannerSource | undefined;
  /** Caption under the thumbnail, e.g. "report.pdf · 3". */
  label: string;
  /** Visual state for select modes. */
  tone?: "normal" | "removed" | "picked";
  children?: ReactNode;
}

const badge = "absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center";

export default function PlannerCard({ item, source, label, tone = "normal", children }: Props) {
  const t = useT("pages");
  const frame =
    tone === "removed" ? "outline outline-2 outline-danger"
    : tone === "picked" ? selectedOutline
    : "";
  return (
    <div data-testid="planner-card" className={`overflow-hidden border border-line bg-surface ${frame}`}>
      <div className="relative aspect-[8.5/11] w-full overflow-hidden bg-surface">
        {item.kind === "page" && source ? (
          <div
            className={`absolute inset-0 flex items-center justify-center ${tone === "removed" ? "opacity-30" : ""}`}
            style={{ transform: thumbnailTransform(item.rotate), transition: "transform 0.3s ease" }}
          >
            <PageImage source={source.bytes} page={item.page} width={160} alt={label} />
          </div>
        ) : (
          <div className="absolute inset-3 flex items-center justify-center border border-dashed border-line-strong bg-paper font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            {t("blankPage")}
          </div>
        )}
        {tone === "removed" && (
          <div className={`${badge} bg-danger text-paper`} aria-hidden="true">
            <X strokeWidth={2} className="h-4 w-4" />
          </div>
        )}
        {tone === "picked" && (
          <div className={`${badge} bg-ink text-paper`} aria-hidden="true">
            <Check strokeWidth={2} className="h-4 w-4" />
          </div>
        )}
        {item.kind === "page" && item.rotate !== 0 && (
          <div className="absolute left-1.5 top-1.5 bg-ink px-1.5 py-0.5 font-mono text-[10px] text-paper">{item.rotate}°</div>
        )}
      </div>
      <div className="truncate border-t border-line px-2 py-1.5 text-center font-mono text-[11px] tracking-[0.04em] text-ink-2">{label}</div>
      {children}
    </div>
  );
}
