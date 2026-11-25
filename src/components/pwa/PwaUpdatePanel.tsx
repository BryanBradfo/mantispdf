import { useSyncExternalStore, type KeyboardEvent } from "react";
import { useT } from "../../i18n";
import { applyUpdate, dismissSwUpdate, getSwUpdateView, subscribeSwUpdate } from "../../pwa/swUpdate";
import { primaryButton, secondaryButton } from "../../styles/ui";

/**
 * The web app's update panel, bottom right, in the desktop update banner's look. Shown when a new version
 * (service worker) waits; mounted by App outside Tauri only. It never takes the focus and never reloads
 * by itself: Reload is the person's choice (a file open in a tool would be lost), Escape means Later.
 */
export default function PwaUpdatePanel() {
  const t = useT("common");
  const { visible } = useSyncExternalStore(subscribeSwUpdate, getSwUpdateView, getSwUpdateView);
  if (!visible) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismissSwUpdate();
  };

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={t("updateRegion")}
      onKeyDown={onKeyDown}
      data-testid="pwa-update"
      className="fixed bottom-4 right-4 z-40 w-[calc(100vw-2rem)] max-w-sm rounded-none border border-line-strong bg-paper p-5"
    >
      <p className="eyebrow">{t("updateEyebrow")}</p>
      <h2 className="mt-2 font-display text-2xl font-light leading-tight tracking-[-0.01em] text-ink">{t("pwaUpdateReady")}</h2>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void applyUpdate()} className={primaryButton}>
          {t("pwaReload")}
        </button>
        <button type="button" onClick={dismissSwUpdate} className={secondaryButton}>
          {t("updateLater")}
        </button>
      </div>
    </section>
  );
}
