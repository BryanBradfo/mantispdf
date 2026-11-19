import { memo } from "react";
import { Check } from "lucide-react";
import { useT } from "../../i18n";
import type { Change, PageSpan } from "../../lib/compare/types";
import { focusRing, monoLabel } from "../../styles/ui";

/** Above this many changes, only the first ones are listed (the highlights still show them all). */
export const LIST_CAP = 1000;

interface Props {
  changes: readonly Change[];
  active: number | null;
  onPick: (index: number) => void;
}

/** The page a change sits on (original page for removed text, modified page for added text). */
function pageOf(c: Change, side: "a" | "b"): number | null {
  const span: PageSpan | null = side === "a" ? c.aPages : c.bPages;
  return span ? span.first + 1 : null;
}

/** The list of changes: the accessible representation of the comparison. Each item scrolls both columns to it. */
function ChangesList({ changes, active, onPick }: Props) {
  const t = useT("compare");
  const shown = changes.length > LIST_CAP ? changes.slice(0, LIST_CAP) : changes;
  return (
    <div>
      <ol className="divide-y divide-line border-y border-line" data-testid="compare-changes">
        {shown.map((c, i) => {
          const pa = pageOf(c, "a");
          const pb = pageOf(c, "b");
          const page =
            c.kind === "removed"
              ? t("page", { page: pa ?? 0 })
              : c.kind === "added"
                ? t("page", { page: pb ?? 0 })
                : pa === pb
                  ? t("page", { page: pa ?? 0 })
                  : t("pages", { a: pa ?? 0, b: pb ?? 0 });
          const short =
            c.kind === "removed"
              ? t("pageShort", { page: pa ?? 0 })
              : c.kind === "added"
                ? t("pageShort", { page: pb ?? 0 })
                : pa === pb
                  ? t("pageShort", { page: pa ?? 0 })
                  : t("pagesShort", { a: pa ?? 0, b: pb ?? 0 });
          const name =
            c.kind === "removed"
              ? t("itemRemoved", { page, text: c.aText })
              : c.kind === "added"
                ? t("itemAdded", { page, text: c.bText })
                : t("itemChanged", { page, removed: c.aText, added: c.bText });
          const kind = c.kind === "removed" ? t("kindRemoved") : c.kind === "added" ? t("kindAdded") : t("kindChanged");
          const on = i === active;
          return (
            <li key={i}>
              <button
                type="button"
                aria-label={name}
                aria-current={on ? "true" : undefined}
                data-kind={c.kind}
                onClick={() => onPick(i)}
                className={`group relative block w-full px-3 py-3 text-left ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0 ${
                  on ? "text-ink outline outline-2 -outline-offset-2 outline-ink" : "text-ink hover:bg-surface"
                }`}
              >
                <span className={`${monoLabel} flex items-center justify-between gap-3`} aria-hidden="true">
                  <span className="flex items-center gap-1.5">
                    {on && <Check strokeWidth={2} className="h-3.5 w-3.5 text-ink" />}
                    {kind}
                  </span>
                  <span>{short}</span>
                </span>
                <span className="mt-1.5 block space-y-0.5 text-sm leading-snug" aria-hidden="true">
                  {c.aText && (
                    <span className="flex gap-2">
                      <span className="w-3 shrink-0 font-mono">−</span>
                      <span className={`min-w-0 break-words line-through decoration-1 text-ink-2`}>{c.aText}</span>
                    </span>
                  )}
                  {c.bText && (
                    <span className="flex gap-2">
                      <span className="w-3 shrink-0 font-mono">+</span>
                      <span className="min-w-0 break-words">{c.bText}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {changes.length > LIST_CAP && (
        <p className={`${monoLabel} mt-3`}>{t("listCapped", { shown: LIST_CAP, total: changes.length })}</p>
      )}
    </div>
  );
}

export default memo(ChangesList);
