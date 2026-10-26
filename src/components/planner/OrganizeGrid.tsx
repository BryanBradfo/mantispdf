import type { Dispatch } from "react";
import type { PlannerAction, PlannerItem, PlannerState } from "../../hooks/usePagePlanner";
import SortableGrid from "../common/SortableGrid";
import PlannerCard from "./PlannerCard";
import { useT, type NsT } from "../../i18n";

export function captionFor(item: PlannerItem, state: PlannerState, t: NsT<"pages">): string {
  if (item.kind === "blank") return t("blankPage");
  const source = state.sources.find((s) => s.id === item.srcId);
  return state.sources.length > 1 && source
    ? t("captionSourcePage", { name: source.file.name, page: item.page })
    : t("captionPage", { page: item.page });
}

const btn =
  "flex flex-1 items-center justify-center py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700 cursor-pointer dark:hover:bg-[#1a1a1a] dark:hover:text-[#ccc]";

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
            <div className="flex border-t border-gray-100 dark:border-[#222]">
              {item.kind === "page" && (
                <>
                  <button data-no-dnd className={btn} title={t("rotateLeft")} aria-label={t("rotateLeftItem", { caption })} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: -90 })}>↺</button>
                  <button data-no-dnd className={btn} title={t("rotateRight")} aria-label={t("rotateRightItem", { caption })} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: 90 })}>↻</button>
                  <button data-no-dnd className={btn} title={t("duplicate")} aria-label={t("duplicateItem", { caption })} onClick={() => dispatch({ type: "duplicate-item", id: item.id })}>⧉</button>
                </>
              )}
              <button data-no-dnd className={btn} title={t("insertBlank")} aria-label={t("insertBlankItem", { caption })} onClick={() => dispatch({ type: "insert-blank", index: index + 1 })}>＋</button>
              <button data-no-dnd className={`${btn} hover:!text-red-500`} title={t("delete")} aria-label={t("deleteItem", { caption })} onClick={() => dispatch({ type: "remove-item", id: item.id })}>✕</button>
            </div>
          </PlannerCard>
        );
      }}
    />
  );
}
