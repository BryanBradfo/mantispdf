import { useT } from "../../i18n";
import { primaryButton, secondaryButton } from "../../styles/ui";

interface SplitActionsProps {
  splitCount: number;
  onSplit: () => void;
  onReset: () => void;
  disabled: boolean;
}

export default function SplitActions({ splitCount, onSplit, onReset, disabled }: SplitActionsProps) {
  const t = useT("split");
  const tc = useT("common");
  const parts = splitCount + 1;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={onSplit}
        disabled={disabled || splitCount === 0}
        className={primaryButton}
      >
        {splitCount === 0 ? t("selectPoints") : t("splitInto", { parts })}
      </button>
      <button
        onClick={onReset}
        className={secondaryButton}
      >
        {tc("reset")}
      </button>
    </div>
  );
}
