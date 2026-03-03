interface ProgressOverlayProps {
  progress: number;
  message: string;
  error: string | null;
  onDismissError: () => void;
}

export default function ProgressOverlay({ progress, message, error, onDismissError }: ProgressOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
        {error ? (
          <>
            <p className="mb-4 text-sm font-medium text-red-600">{error}</p>
            <button
              onClick={onDismissError}
              className="w-full rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <p className="mb-3 text-sm font-medium text-gray-700">{message}</p>
            <div className="h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-mantis-500 transition-all duration-300"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-right text-xs text-gray-400">
              {Math.round(progress * 100)}%
            </p>
          </>
        )}
      </div>
    </div>
  );
}
