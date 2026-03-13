interface SplitActionsProps {
  splitCount: number;
  onSplit: () => void;
  onReset: () => void;
  disabled: boolean;
}

export default function SplitActions({ splitCount, onSplit, onReset, disabled }: SplitActionsProps) {
  const parts = splitCount + 1;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onSplit}
        disabled={disabled || splitCount === 0}
        className="rounded-lg bg-mantis-600 px-6 py-2.5 font-medium text-white transition hover:bg-mantis-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {splitCount === 0
          ? "Select split points below"
          : `Split into ${parts} parts`}
      </button>
      <button
        onClick={onReset}
        className="rounded-lg border border-gray-300 px-4 py-2.5 font-medium text-gray-700 transition hover:bg-gray-50 dark:border-[#222] dark:text-[#aaa] dark:hover:bg-[#141414]"
      >
        Reset
      </button>
    </div>
  );
}
