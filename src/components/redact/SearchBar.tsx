import { useEffect, useId, useState } from "react";
import { entryText, selectedMarks, type SearchEntry } from "../../lib/redact/marking";
import type { MarkInput } from "../../lib/redact/model";
import { useT } from "../../i18n";
import { pageListText } from "../../lib/redact/report";
import { checkClass, inputClass, linkClass, secondaryButton } from "../../styles/ui";

export interface SearchResult {
  query: string;
  /** Matches found (a match across lines counts once). */
  count: number;
  /** Pages with at least one match, ascending. */
  pages: number[];
  /** The matches, for the review list. */
  entries: SearchEntry[];
}

interface Props {
  /** True while the pages are being searched. */
  searching: boolean;
  result: SearchResult | null;
  onFind: (query: string, wholeWord: boolean) => void;
  /** Mark the given areas (the checked ones, or all of them). */
  onMark: (marks: MarkInput[]) => void;
  /** Show a match on its page. */
  onShow: (entry: SearchEntry) => void;
  /** A redaction runs or waits for its go-ahead: "Find" and marking wait. */
  locked: boolean;
}

const fieldClass = `${inputClass} !mt-0 h-9 !py-1.5`;
const buttonClass = `${secondaryButton} h-9 shrink-0 px-3 text-xs`;

/**
 * "Find text": every case-insensitive match on every page, reviewed in a list (all checked at
 * first), then "Mark selected" or the "Mark all" shortcut.
 */
export default function SearchBar({ searching, result, onFind, onMark, onShow, locked }: Props) {
  const t = useT("redact");
  const [query, setQuery] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const id = useId();

  // A new search starts with every area checked.
  useEffect(() => setChecked(new Set(result?.entries.map((e) => e.id) ?? [])), [result]);

  const toggle = (entry: number) =>
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(entry)) next.delete(entry);
      else next.add(entry);
      return next;
    });

  const pagesLabel = (pages: number[]) =>
    pages.length <= 8
      ? pageListText(pages, t)
      : t("pageList", {
          count: pages.length,
          list: t("listMore", { list: pages.slice(0, 8).join(t("listSep")), count: pages.length - 8 }),
        });

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-none border border-line bg-surface p-4">
      <h2 id={`${id}-title`} className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink">
        {t("findText")}
      </h2>
      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim() !== "") onFind(query, wholeWord);
        }}
      >
        <div className="flex gap-2">
          <input
            type="search"
            aria-label={t("textToFind")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className={fieldClass}
          />
          <button type="submit" disabled={searching || locked || query.trim() === ""} className={buttonClass}>
            {searching ? t("finding") : t("find")}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
            className={checkClass}
          />
          {t("wholeWords")}
        </label>
        <p className="text-xs text-ink-2">{t("hyphenNote")}</p>
      </form>
      {result && (
        <div className="mt-3" role="status">
          {result.count === 0 ? (
            <p className="text-sm text-ink-2">{t("noMatch", { query: result.query })}</p>
          ) : (
            <>
              <p className="text-sm text-ink">
                {t("matches", { count: result.count, query: result.query, pages: pagesLabel(result.pages) })}
              </p>
              <ul aria-label={t("results")} className="mt-2 max-h-48 space-y-1 overflow-y-auto p-1">
                {result.entries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                    <label className="flex items-center gap-2 text-ink">
                      <input
                        type="checkbox"
                        checked={checked.has(e.id)}
                        disabled={locked}
                        onChange={() => toggle(e.id)}
                        className={`${checkClass} focus-visible:!ring-offset-0`}
                      />
                      {(() => {
                        const entry = entryText(e);
                        return (
                          <span>
                            {t("entryPage", { page: entry.page })}
                            {entry.before}
                            <strong>{entry.text}</strong>
                            {entry.after}
                          </span>
                        );
                      })()}
                    </label>
                    <button type="button" onClick={() => onShow(e)} className={`shrink-0 text-xs ${linkClass} focus-visible:!ring-offset-0`}>
                      {t("show")}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onMark(selectedMarks(result.entries, checked))}
                  disabled={locked || checked.size === 0}
                  className={buttonClass}
                >
                  {t("markSelected", { count: checked.size })}
                </button>
                <button type="button" onClick={() => onMark(result.entries.flatMap((e) => e.marks))} disabled={locked} className={buttonClass}>
                  {t("markAll")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
