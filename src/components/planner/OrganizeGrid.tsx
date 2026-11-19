import type { Dispatch } from "react";
import type { PlannerAction, PlannerItem, PlannerState } from "../../hooks/usePagePlanner";
import SortableGrid from "../common/SortableGrid";
import PlannerCard from "./PlannerCard";
import { Copy, Plus, RotateCcw, RotateCw, X } from "lucide-react";
import { useT, type NsT } from "../../i18n";
import { cellButton } from "../../styles/ui";

export function captionFor(item: PlannerItem, state: PlannerState, t: NsT<"pages">): string {
  if (item.kind === "blank") return t("blankPage");
  const source = state.sources.find((s) => s.id === item.srcId);
  return state.sources.length > 1 && source
    ? t("captionSourcePage", { name: source.file.name, page: item.page })
    : t("captionPage", { page: item.page });
}

const btn = `${cellButton} h-8 cursor-pointer`;
const icon = { "aria-hidden": true, strokeWidth: 1.5, className: "h-4 w-4" } as const;

export default function OrganizeGrid({ state, dispatch }: { state: PlannerState; dispatch: Dispatch<PlannerAction> }) {
  const t = useT("pages");
  return (
    <SortableGrid
      items={state.items}
      onReorder={(from, to) => dispatch({ type: "reorder", from, to })}
      label={(item) => captionFor(item, state, t)}
      className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4"
      renderItem={(item, index) => {
        const caption = captionFor(item, state, t);
        const source = item.kind === "page" ? state.sources.find((s) => s.id === item.srcId) : undefined;
        return (
          <PlannerCard item={item} source={source} label={caption}>
            <div className="flex divide-x divide-line border-t border-line">
              {item.kind === "page" && (
                <>
                  <button data-no-dnd className={btn} title={t("rotateLeft")} aria-label={t("rotateLeftItem", { caption })} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: -90 })}><RotateCcw {...icon} /></button>
                  <button data-no-dnd className={btn} title={t("rotateRight")} aria-label={t("rotateRightItem", { caption })} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: 90 })}><RotateCw {...icon} /></button>
                  <button data-no-dnd className={btn} title={t("duplicate")} aria-label={t("duplicateItem", { caption })} onClick={() => dispatch({ type: "duplicate-item", id: item.id })}><Copy {...icon} /></button>
                </>
              )}
              <button data-no-dnd className={btn} title={t("insertBlank")} aria-label={t("insertBlankItem", { caption })} onClick={() => dispatch({ type: "insert-blank", index: index + 1 })}><Plus {...icon} /></button>
              <button data-no-dnd className={`${btn} hover:!bg-danger hover:!text-paper`} title={t("delete")} aria-label={t("deleteItem", { caption })} onClick={() => dispatch({ type: "remove-item", id: item.id })}><X {...icon} /></button>
            </div>
          </PlannerCard>
        );
      }}
    />
  );
}
