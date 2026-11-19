import { Check, Redo2, Trash2, Undo2 } from "lucide-react";
import type { Mark } from "../../lib/redact/model";
import type { Fill } from "../../lib/redact/toJob";
import { useLocale, useT, type NsT } from "../../i18n";
import { checkClass, focusRing, monoLabel, panelClass, selectedOutline, smallButton } from "../../styles/ui";

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

/** Controls inside the scrolling marks list: the ring sits flush, an offset one is clipped by the scroller. */
const inListRing = "focus-visible:!ring-offset-0";

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
      <section aria-label={t("marks")} className={`${panelClass} !mt-0 !p-4`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className={monoLabel}>
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

        <label className="mt-3 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={props.wholePage}
            disabled={locked}
            onChange={props.onToggleWholePage}
            className={checkClass}
          />
          {t("wholePage", { page })}
        </label>

        {marks.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">{t("noMarks")}</p>
        ) : (
          <ol className="mt-3 max-h-72 space-y-3 overflow-y-auto p-1">
            {pages.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  onClick={() => props.onPage(p)}
                  aria-current={p === page ? "page" : undefined}
                  className={`font-mono text-[11px] uppercase tracking-[0.08em] underline-offset-4 hover:underline aria-[current=page]:text-ink aria-[current=page]:underline ${focusRing} ${inListRing} text-ink-2`}
                >
                  {tc("pageN", { n: p })}
                </button>
                <ul className="mt-1 space-y-1">
                  {marks
                    .filter((m) => m.page === p)
                    .map((m) => (
                      <li
                        key={m.id}
                        data-mark-row=""
                        className={`flex items-center justify-between gap-2 px-2 py-1 text-sm ${
                          m.id === props.selectedId ? `${selectedOutline} -outline-offset-2` : ""
                        }`}
                      >
                        <button
                          type="button"
                          aria-pressed={m.id === props.selectedId}
                          onClick={() => {
                            props.onPage(m.page);
                            props.onSelect(m.kind === "page" ? null : m.id);
                          }}
                          className={`flex min-w-0 items-center gap-1.5 text-left text-ink hover:underline hover:underline-offset-4 ${focusRing} ${inListRing}`}
                        >
                          {m.id === props.selectedId && <Check aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{describe(m, t)}</span>
                        </button>
                        <button type="button" aria-label={t("deleteMark", { mark: describe(m, t).toLocaleLowerCase(locale), page: m.page })} disabled={locked} onClick={() => props.onRemove(m.id)} className={`${smallButton} ${inListRing}`}>
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

      <section aria-label={t("output")} className={`${panelClass} !mt-0 !p-4`}>
        <fieldset>
          <legend className={monoLabel}>{t("boxColour")}</legend>
          <div className="mt-2 flex gap-4">
            {(["black", "white"] as const).map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="redact-fill"
                  checked={props.fill === f}
                  disabled={locked}
                  onChange={() => props.onFill(f)}
                  className={checkClass}
                />
                {f === "black" ? t("black") : t("white")}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="mt-3 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={props.removeMetadata}
            disabled={locked}
            onChange={(e) => props.onRemoveMetadata(e.target.checked)}
            className={`mt-0.5 ${checkClass}`}
          />
          {t("removeMetadata")}
        </label>
      </section>
    </div>
  );
}
