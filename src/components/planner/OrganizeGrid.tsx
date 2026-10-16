import type { Dispatch } from "react";
import type { PlannerAction, PlannerItem, PlannerState } from "../../hooks/usePagePlanner";
import SortableGrid from "../common/SortableGrid";
import PlannerCard from "./PlannerCard";

export function captionFor(item: PlannerItem, state: PlannerState): string {
  if (item.kind === "blank") return "Blank page";
  const source = state.sources.find((s) => s.id === item.srcId);
  return state.sources.length > 1 && source ? `${source.file.name} · ${item.page}` : `Page ${item.page}`;
}

const btn =
  "flex flex-1 items-center justify-center py-1.5 text-sm text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700 cursor-pointer dark:hover:bg-[#1a1a1a] dark:hover:text-[#ccc]";

export default function OrganizeGrid({ state, dispatch }: { state: PlannerState; dispatch: Dispatch<PlannerAction> }) {
  return (
    <SortableGrid
      items={state.items}
      onReorder={(from, to) => dispatch({ type: "reorder", from, to })}
      label={(item) => captionFor(item, state)}
      className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4"
      renderItem={(item, index) => {
        const caption = captionFor(item, state);
        const source = item.kind === "page" ? state.sources.find((s) => s.id === item.srcId) : undefined;
        return (
          <PlannerCard item={item} source={source} label={caption}>
            <div className="flex border-t border-gray-100 dark:border-[#222]">
              {item.kind === "page" && (
                <>
                  <button data-no-dnd className={btn} title="Rotate left" aria-label={`Rotate ${caption} left`} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: -90 })}>↺</button>
                  <button data-no-dnd className={btn} title="Rotate right" aria-label={`Rotate ${caption} right`} onClick={() => dispatch({ type: "rotate-item", id: item.id, delta: 90 })}>↻</button>
                  <button data-no-dnd className={btn} title="Duplicate" aria-label={`Duplicate ${caption}`} onClick={() => dispatch({ type: "duplicate-item", id: item.id })}>⧉</button>
                </>
              )}
              <button data-no-dnd className={btn} title="Insert blank page after" aria-label={`Insert blank page after ${caption}`} onClick={() => dispatch({ type: "insert-blank", index: index + 1 })}>＋</button>
              <button data-no-dnd className={`${btn} hover:!text-red-500`} title="Delete" aria-label={`Delete ${caption}`} onClick={() => dispatch({ type: "remove-item", id: item.id })}>✕</button>
            </div>
          </PlannerCard>
        );
      }}
    />
  );
}
