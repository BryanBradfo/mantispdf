import PageImage from "../common/PageImage";
import { Check } from "lucide-react";
import { useT } from "../../i18n";
import { focusRing } from "../../styles/ui";
import { pageBadge, pageDot, pageSelected } from "../../styles/onPage";

interface Props {
  source: Blob | Uint8Array;
  pageCount: number;
  /** 1-based page shown in the editor. */
  page: number;
  /** Pages marked with a dot (pages that carry at least one edit, by default). */
  edited: ReadonlySet<number>;
  onPage: (page: number) => void;
  /** What a dot means, read out after the page number and shown as its tooltip. */
  markLabel?: string;
}

export default function PageStrip({ source, pageCount, page, edited, onPage, markLabel: markProp }: Props) {
  const t = useT("common");
  const markLabel = markProp ?? t("pageEdited");
  return (
    <div className="flex gap-2 overflow-x-auto p-1 pb-2" role="group" aria-label={t("pagesGroup")}>
      {Array.from({ length: pageCount }, (_, i) => {
        const n = i + 1;
        const isEdited = edited.has(n);
        const on = page === n;
        return (
          <button
            key={n}
            type="button"
            aria-label={isEdited ? t("pageNMarked", { n, mark: markLabel }) : t("pageN", { n })}
            aria-pressed={on}
            onClick={() => onPage(n)}
            className={`relative w-16 shrink-0 border bg-paper ${focusRing} ${
              on ? "border-ink" : "border-line hover:border-line-strong"
            }`}
          >
            <PageImage source={source} page={n} width={64} alt="" />
            <span className="block border-t border-line py-0.5 font-mono text-[11px] text-ink-2">{n}</span>
            {on && (
              <>
                {/* On an inner layer, so the focus ring's outline-none on the button cannot hide the selection; black, it is drawn on the page. */}
                <span data-selected-frame aria-hidden="true" className={`pointer-events-none absolute inset-0 ${pageSelected} -outline-offset-2`} />
                <span aria-hidden="true" className={`absolute left-1 top-1 flex h-4 w-4 items-center justify-center ${pageBadge}`}>
                  <Check strokeWidth={2} className="h-3 w-3" />
                </span>
              </>
            )}
            {isEdited && (
              <span
                aria-hidden="true"
                data-edited-mark
                title={markLabel.charAt(0).toUpperCase() + markLabel.slice(1)}
                className={`absolute right-1 top-1 h-2.5 w-2.5 rounded-full ${pageDot}`}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
