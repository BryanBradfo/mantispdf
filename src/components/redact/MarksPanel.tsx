import { Redo2, Trash2, Undo2 } from "lucide-react";
import type { Mark } from "../../lib/redact/model";
import type { Fill } from "../../lib/redact/toJob";
import { useLocale, useT, type NsT } from "../../i18n";

interface Props {
  marks: readonly Mark[];
  /** Page shown in the canvas. */
  page: number;
  onPage: (page: number) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Whether the shown page is marked whole, and how to change it. */
  wholePage: boolean;
  onToggleWholePage: () => void;
  fill: Fill;
  onFill: (fill: Fill) => void;
  removeMetadata: boolean;
  onRemoveMetadata: (on: boolean) => void;
  /** A redaction is running or waiting for its go-ahead: nothing here can change. */
  locked: boolean;
}

const smallButton =
  "flex items-center justify-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 disabled:opacity-40 dark:border-[#333] dark:text-[#bbb] dark:hover:bg-[#1a1a1a]";

function describe(m: Mark, t: NsT<"redact">): string {
  switch (m.kind) {
    case "area":
      return t("markArea");
    case "search":
      return t("markMatch", { query: m.query });
    case "page":
      return t("markPage");
  }
}

/** The marks by page, history, whole-page toggle and output options. */
export default function MarksPanel(props: Props) {
  const t = useT("redact");
  const tc = useT("common");
  const locale = useLocale();
  const { marks, page, locked } = props;
  const pages = [...new Set(marks.map((m) => m.page))].sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      <section aria-label={t("marks")} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">
            {t("marksCount", { count: marks.length })}
          </h2>
          <div className="flex gap-1">
            <button type="button" aria-label={tc("undo")} title={tc("undo") + " (Ctrl+Z)"} disabled={locked || !props.canUndo} onClick={props.onUndo} className={smallButton}>
              <Undo2 aria-hidden="true" className="h-4 w-4" />
            </button>
            <button type="button" aria-label={tc("redo")} title={tc("redo") + " (Ctrl+Shift+Z)"} disabled={locked || !props.canRedo} onClick={props.onRedo} className={smallButton}>
              <Redo2 aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={props.wholePage}
            disabled={locked}
            onChange={props.onToggleWholePage}
            className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          {t("wholePage", { page })}
        </label>

        {marks.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600 dark:text-[#888]">{t("noMarks")}</p>
        ) : (
          <ol className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
            {pages.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => props.onPage(p)}
                  aria-current={p === page ? "page" : undefined}
                  className="text-xs font-semibold text-gray-600 underline-offset-2 hover:underline dark:text-[#999]"
                >
                  {tc("pageN", { n: p })}
                </button>
                <ul className="mt-1 space-y-1">
                  {marks
                    .filter((m) => m.page === p)
                    .map((m) => (
                      <li
                        key={m.id}
                        className={`flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm ${
                          m.id === props.selectedId ? "bg-mantis-50 dark:bg-[#0f1a0f]" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            props.onPage(m.page);
                            props.onSelect(m.kind === "page" ? null : m.id);
                          }}
                          className="min-w-0 truncate text-left text-gray-800 dark:text-[#ccc]"
                        >
                          {describe(m, t)}
                        </button>
                        <button type="button" aria-label={t("deleteMark", { mark: describe(m, t).toLocaleLowerCase(locale), page: m.page })} disabled={locked} onClick={() => props.onRemove(m.id)} className={smallButton}>
                          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                          {tc("delete")}
                        </button>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {marks.length > 0 && (
          <button type="button" disabled={locked} onClick={props.onClear} className={`mt-3 ${smallButton}`}>
            {t("removeAll")}
          </button>
        )}
      </section>

      <section aria-label={t("output")} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#333] dark:bg-[#111]">
        <fieldset>
          <legend className="text-sm font-semibold text-gray-900 dark:text-[#ddd]">{t("boxColour")}</legend>
          <div className="mt-2 flex gap-4">
            {(["black", "white"] as const).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
                <input
                  type="radio"
                  name="redact-fill"
                  checked={props.fill === f}
                  disabled={locked}
                  onChange={() => props.onFill(f)}
                  className="h-4 w-4 border-gray-300 text-mantis-600 focus:ring-mantis-500"
                />
                {f === "black" ? t("black") : t("white")}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-[#aaa]">
          <input
            type="checkbox"
            checked={props.removeMetadata}
            disabled={locked}
            onChange={(e) => props.onRemoveMetadata(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
          />
          {t("removeMetadata")}
        </label>
      </section>
    </div>
  );
}
