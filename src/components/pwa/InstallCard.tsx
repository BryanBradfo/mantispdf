import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Check, Info } from "lucide-react";
import { useT } from "../../i18n";
import { getInstallState, promptInstall, subscribeInstall, type InstallState } from "../../pwa/install";
import { monoLabel, noticeClass, primaryButton } from "../../styles/ui";

/** The instruction shown instead of the button, per browser. */
const HINTS = {
  ios: "installIos",
  "safari-mac": "installSafari",
  "firefox-desktop": "installFirefox",
  unavailable: "installOther",
} as const satisfies Partial<Record<InstallState, string>>;

/** The current install state (src/pwa/install.ts), for React. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, getInstallState, getInstallState);
}

/**
 * /download's first card: install MantisPDF as a web app from the browser (no download, no OS warning,
 * works offline). A button where the browser offers its install prompt (Chromium), the steps elsewhere
 * (iOS, Safari, Firefox). Hidden in the desktop app and in the installed web app.
 */
export default function InstallCard() {
  const t = useT("download");
  const state = useInstallState();
  if (isTauri() || state === "standalone") return null;

  return (
    <section data-testid="install-card" aria-labelledby="install-card-heading" className="mt-10 border border-line p-5 sm:p-8">
      <p className={monoLabel}>{t("installEyebrow")}</p>
      <h2 id="install-card-heading" className="mt-3 font-display text-3xl font-light leading-tight tracking-[-0.01em] text-ink">
        {t("installHeading")}
      </h2>
      <p className="mt-2 leading-relaxed text-ink-2">{t("installIntro")}</p>
      {state === "available" ? (
        <button type="button" onClick={() => void promptInstall()} className={`${primaryButton} mt-6 h-12 px-6`}>
          {t("installButton")}
        </button>
      ) : state === "installed" ? (
        <p role="status" className="mt-6 flex items-start gap-3 text-sm text-ink">
          <Check aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("installDone")}</span>
        </p>
      ) : (
        <p className={`${noticeClass} mt-6 flex items-start gap-3`}>
          <Info aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t(HINTS[state])}</span>
        </p>
      )}
    </section>
  );
}
