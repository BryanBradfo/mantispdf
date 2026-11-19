import { X } from "lucide-react";
import { formatBytes, useLocale, useT, type UiError } from "../../i18n";
import DropZone from "../common/DropZone";
import LoadingRow from "../common/LoadingRow";
import { fileMeta, focusRing, monoLabel } from "../../styles/ui";

export type SlotView =
  | { kind: "empty"; error: UiError | null }
  | { kind: "reading"; file: File }
  | { kind: "ready"; file: File; pages: number };

interface Props {
  /** "A" or "B": the mono marker before the label. */
  marker: string;
  label: string;
  removeLabel: string;
  slot: SlotView;
  engineReady: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
  testId: string;
}

/** One input of the comparison: a drop zone, then the chosen file with its page count and a remove button. */
export default function FileSlot({ marker, label, removeLabel, slot, engineReady, onFile, onRemove, testId }: Props) {
  const t = useT("compare");
  const locale = useLocale();
  return (
    <section data-testid={testId} aria-label={label} className="flex min-w-0 flex-col">
      <p className={`${monoLabel} mb-2 flex items-center gap-2`}>
        <span className="text-ink">{marker}</span>
        <span aria-hidden="true">/</span>
        <span>{label}</span>
      </p>
      {slot.kind === "empty" ? (
        <DropZone onFile={onFile} error={slot.error} engineReady={engineReady} />
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-6 border border-line bg-surface p-5">
          <div className="flex items-start justify-between gap-4">
            <p className="min-w-0 break-words font-display text-2xl font-light leading-tight tracking-[-0.01em] text-ink">{slot.file.name}</p>
            <button
              type="button"
              onClick={onRemove}
              aria-label={removeLabel}
              title={removeLabel}
              className={`-mr-2 -mt-2 flex h-9 w-9 shrink-0 items-center justify-center text-ink-2 hover:text-ink ${focusRing}`}
            >
              <X aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
            </button>
          </div>
          {slot.kind === "reading" ? (
            <LoadingRow label={t("readingFile")} />
          ) : (
            <p className={fileMeta}>
              {t("pageCount", { count: slot.pages })} · {formatBytes(slot.file.size, locale)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
