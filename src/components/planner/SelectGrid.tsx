import type { Dispatch } from "react";
import type { PlannerAction, PlannerState } from "../../hooks/usePagePlanner";
import PlannerCard from "./PlannerCard";
import { captionFor } from "./OrganizeGrid";

export default function SelectGrid({ state, dispatch, mode }: { state: PlannerState; dispatch: Dispatch<PlannerAction>; mode: "remove" | "extract" }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
      {state.items.map((item) => {
        const on = state.selected.has(item.id);
        const caption = captionFor(item, state);
        const source = item.kind === "page" ? state.sources.find((s) => s.id === item.srcId) : undefined;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={on}
            aria-label={`${mode === "remove" ? "Remove" : "Extract"} ${caption}`}
            onClick={() => dispatch({ type: "toggle-select", id: item.id })}
            className="rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 focus-visible:ring-offset-2"
          >
            <PlannerCard item={item} source={source} label={caption} tone={on ? (mode === "remove" ? "removed" : "picked") : "normal"} />
          </button>
        );
      })}
    </div>
  );
}
