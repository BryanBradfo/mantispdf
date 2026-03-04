interface MergeActionsProps {
  fileCount: number;
  onMerge: () => void;
  onReset: () => void;
  disabled: boolean;
}

export default function MergeActions({ fileCount, onMerge, onReset, disabled }: MergeActionsProps) {
  const canMerge = fileCount >= 2 && !disabled;

  return (
    <div className="flex gap-3">
      <button
        onClick={onMerge}
        disabled={!canMerge}
        className="rounded-lg bg-mantis-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-mantis-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Merge {fileCount} file{fileCount !== 1 ? "s" : ""}
      </button>
      <button
        onClick={onReset}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
      >
        Reset
      </button>
    </div>
  );
}
