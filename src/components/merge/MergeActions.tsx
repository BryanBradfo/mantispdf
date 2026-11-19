import React from "react";
import { useT } from "../../i18n";
import { primaryButton, secondaryButton } from "../../styles/ui";

interface MergeActionsProps {
  fileCount: number;
  onMerge: () => void;
  onReset: () => void;
  disabled: boolean;
}

export default React.memo(function MergeActions({ fileCount, onMerge, onReset, disabled }: MergeActionsProps) {
  const t = useT("merge");
  const tc = useT("common");
  const canMerge = fileCount >= 2 && !disabled;

  return (
    <div className="flex gap-3">
      <button
        onClick={onMerge}
        disabled={!canMerge}
        className={primaryButton}
      >
        {t("mergeFiles", { count: fileCount })}
      </button>
      <button
        onClick={onReset}
        className={secondaryButton}
      >
        {tc("reset")}
      </button>
    </div>
  );
});
