import { useEffect, useRef } from "react";
import { formatNumber, useLocale, useT, type UiError } from "../../i18n";
import ErrorText from "./ErrorText";
import { secondaryButton } from "../../pages/ToolShell";

interface ProgressOverlayProps {
  progress: number;
  message: string;
  error: UiError | null;
  onDismissError: () => void;
}

export default function ProgressOverlay({ progress, message, error, onDismissError }: ProgressOverlayProps) {
  const t = useT("common");
  const locale = useLocale();
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
      aria-label={error ? t("progressError") : t("progressProcessing")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-paper/80 px-4"
    >
      <div className="w-full max-w-sm border border-line bg-surface p-6">
        {error ? (
          <>
            <div className="mb-5 text-sm font-medium text-danger" aria-live="assertive">
              <ErrorText error={error} />
            </div>
            <button
              ref={dismissRef}
              onClick={onDismissError}
              className={`${secondaryButton} w-full`}
            >
              {t("dismiss")}
            </button>
          </>
        ) : (
          <>
            <p className={`mb-4 text-sm text-ink${progress < 0.1 ? " animate-pulse" : ""}`}>{message}</p>
            <div className="h-0.5 overflow-hidden bg-line">
              {progress < 0.1 ? (
                <div className="h-full w-1/2 bg-ink-3 animate-shimmer" />
              ) : (
                <div
                  className="h-full bg-ink"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              )}
            </div>
            <p className="mt-3 text-right font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
              {progress < 0.1 ? t("progressWorking") : formatNumber(Math.round(progress * 100) / 100, locale, { style: "percent" })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
