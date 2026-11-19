import { Check } from "lucide-react";
import PageImage from "../common/PageImage";
import { useT } from "../../i18n";
import { focusRing } from "../../styles/ui";
import { pageBadge, pageSelected } from "../../styles/onPage";

interface Props {
  source: Blob | Uint8Array;
  count: number;
  /** 1-based page shown in the crop canvas. */
  page: number;
  disabled: boolean;
  onPage: (page: number) => void;
}

/** Row of page thumbnails above the crop canvas; the shown page is outlined in ink with a check. */
export default function CropPageStrip({ source, count, page, disabled, onPage }: Props) {
  const tc = useT("common");
  return (
    <div className="mt-4 flex gap-2 overflow-x-auto p-1 pb-2" role="group" aria-label={tc("pagesGroup")}>
      {Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        const on = page === n;
        return (
          <button
            key={n}
            type="button"
            aria-label={tc("pageN", { n })}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onPage(n)}
            className={`relative w-20 shrink-0 border bg-paper disabled:cursor-not-allowed disabled:opacity-60 ${focusRing} ${
              on ? "border-ink" : "border-line hover:border-line-strong"
            }`}
          >
            <PageImage source={source} page={n} width={80} alt="" />
            <span className="block border-t border-line py-0.5 font-mono text-[11px] text-ink-2">{n}</span>
            {on && (
              <>
                {/* On an inner layer, so the focus ring's outline-none on the button cannot hide the selection; black, it is drawn on the page. */}
                <span data-selected-frame aria-hidden="true" className={`pointer-events-none absolute inset-0 ${pageSelected} -outline-offset-2`} />
                <span aria-hidden="true" className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center ${pageBadge}`}>
                  <Check strokeWidth={2} className="h-3.5 w-3.5" />
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
