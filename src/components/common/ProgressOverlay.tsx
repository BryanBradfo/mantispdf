import { useEffect, useRef } from "react";

interface ProgressOverlayProps {
  progress: number;
  message: string;
  error: string | null;
  onDismissError: () => void;
}

export default function ProgressOverlay({ progress, message, error, onDismissError }: ProgressOverlayProps) {
  const dismissRef = useRef<HTMLButtonElement>(null);

  // When an error is shown, move focus to the Dismiss button and let Escape
  // dismiss it, so keyboard users aren't trapped behind the modal overlay.
  useEffect(() => {
    if (!error) return;
    dismissRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismissError();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [error, onDismissError]);

  return (
    <div
      role={error ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-label={error ? "Error" : "Processing"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-[#141414] dark:shadow-[0_8px_40px_rgba(0,0,0,0.6)]">
        {error ? (
          <>
            <p className="mb-4 text-sm font-medium text-red-600 dark:text-red-400" aria-live="assertive">
              {error}
            </p>
            <button
              ref={dismissRef}
              onClick={onDismissError}
              className="w-full rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-[#1a1a1a] dark:text-[#aaa] dark:hover:bg-[#222]"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <p className={`mb-3 text-sm font-medium text-gray-700 dark:text-[#aaa]${progress < 0.1 ? " animate-pulse" : ""}`}>{message}</p>
            <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-[#222]">
              {progress < 0.1 ? (
                <div className="h-full w-1/2 rounded-full bg-mantis-500 animate-shimmer" />
              ) : (
                <div
                  className="h-full rounded-full bg-mantis-500 transition-all duration-300"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              )}
            </div>
            <p className="mt-2 text-right text-xs text-gray-400 dark:text-[#555]">
              {progress < 0.1 ? "Working…" : `${Math.round(progress * 100)}%`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
