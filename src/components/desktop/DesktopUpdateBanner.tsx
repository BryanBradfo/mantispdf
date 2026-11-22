import { useEffect, useSyncExternalStore, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { useDescribeError, useT } from "../../i18n";
import ErrorText from "../common/ErrorText";
import {
  dismissUpdate,
  getUpdateView,
  installUpdate,
  progressPercent,
  startAutoChecks,
  subscribeUpdate,
} from "../../lib/desktopUpdate";
import { primaryButton, secondaryButton, monoLabel } from "../../styles/ui";

/**
 * The desktop update panel, bottom right. Mounted by App ONLY in Tauri, through `lazy()`, so the web
 * bundle never loads the updater. It starts the background checks and shows itself when one finds a
 * version; it never takes the focus, and Escape inside it means "Later".
 */
export default function DesktopUpdateBanner() {
  const t = useT("common");
  const describe = useDescribeError();
  const view = useSyncExternalStore(subscribeUpdate, getUpdateView);

  useEffect(() => startAutoChecks(), []);

  if (!view.visible || view.version === null) return null;

  const busy = view.phase !== "idle";
  const percent = progressPercent(view);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || busy) return;
    e.preventDefault();
    e.stopPropagation();
    dismissUpdate();
  };

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={t("updateRegion")}
      onKeyDown={onKeyDown}
      className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm rounded-none border border-line-strong bg-paper p-5"
    >
      <p className="eyebrow">{t("updateEyebrow")}</p>
      <h2 className="mt-2 font-display text-2xl font-light leading-tight tracking-[-0.01em] text-ink">
        {t("updateAvailable", { version: view.version })}
      </h2>
      {view.notes && <p className="mt-2 line-clamp-2 text-sm text-ink-2">{view.notes}</p>}

      {busy && (
        <div className="mt-4">
          <div
            role="progressbar"
            aria-label={t("updateProgress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1 w-full bg-line"
          >
            <div
              className="h-full bg-ink transition-[width] duration-150 motion-reduce:transition-none"
              style={{ width: `${view.phase === "restarting" ? 100 : (percent ?? 0)}%` }}
            />
          </div>
          <p className={`mt-2 ${monoLabel}`}>
            {view.phase === "restarting"
              ? t("updateRestarting")
              : percent === null
                ? t("updateDownloadingUnknown")
                : t("updateDownloading", { percent })}
          </p>
        </div>
      )}

      {view.error !== null && view.error !== undefined && (
        <div className="mt-3 text-xs text-danger">
          <ErrorText error={describe(view.error)} />
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" onClick={() => void installUpdate()} disabled={busy} className={`gap-2 ${primaryButton}`}>
          {busy && <Loader2 aria-hidden="true" strokeWidth={1.5} className="h-4 w-4 animate-spin" />}
          {t("updateInstall")}
        </button>
        <button type="button" onClick={dismissUpdate} disabled={busy} className={secondaryButton}>
          {t("updateLater")}
        </button>
      </div>
    </section>
  );
}
