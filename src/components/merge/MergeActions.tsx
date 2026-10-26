import React from "react";
import { useT } from "../../i18n";

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
        className="rounded-lg bg-mantis-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-mantis-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("mergeFiles", { count: fileCount })}
      </button>
      <button
        onClick={onReset}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-[#222] dark:text-[#aaa] dark:hover:bg-[#141414]"
      >
        {tc("reset")}
      </button>
    </div>
  );
});
