import { useId } from "react";
import { gridStep } from "../../lib/gridNav";
import { anchorLabel } from "../../lib/stampBuilders";
import { useT } from "../../i18n";
import type { Anchor } from "../../lib/stampJob";

const ALL: Anchor[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];
const TOP_BOTTOM: Anchor[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

interface Props {
  value: Anchor;
  onChange: (anchor: Anchor) => void;
  label?: string;
  /** "six" omits the middle row (page numbers); default is the full 3x3 grid. */
  layout?: "nine" | "six";
}

export default function PositionPicker({ value, onChange, label, layout = "nine" }: Props) {
  const t = useT("stamp");
  const labelId = useId();
  const anchors = layout === "six" ? TOP_BOTTOM : ALL;
  const rows = layout === "six" ? 2 : 3;
  return (
    <div>
      <span id={labelId} className="block text-sm font-medium text-gray-700 dark:text-[#aaa]">{label ?? t("position")}</span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="mt-1 grid w-28 gap-1 rounded border border-gray-300 bg-white p-1.5 shadow-sm dark:border-[#333] dark:bg-[#141414]"
        style={{ gridTemplateColumns: "repeat(3, 1fr)", aspectRatio: layout === "six" ? "3 / 3.4" : "3 / 4", gridTemplateRows: `repeat(${rows}, 1fr)` }}
      >
        {anchors.map((a) => {
          const checked = a === value;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={anchorLabel(a, t)}
              title={anchorLabel(a, t)}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(a)}
              onKeyDown={(e) => {
                const j = gridStep(anchors.indexOf(a), e.key, 3, anchors.length);
                if (j === null) return;
                e.preventDefault();
                const next = anchors[j];
                onChange(next);
                (e.currentTarget.parentElement?.querySelector(`[aria-label="${anchorLabel(next, t)}"]`) as HTMLElement | null)?.focus();
              }}
              className={`rounded-sm border focus:outline-none focus:ring-2 focus:ring-mantis-500 ${checked ? "border-mantis-600 bg-mantis-600" : "border-gray-200 bg-gray-100 hover:bg-mantis-100 dark:border-[#2a2a2a] dark:bg-[#1f1f1f]"}`}
            />
          );
        })}
      </div>
    </div>
  );
}
