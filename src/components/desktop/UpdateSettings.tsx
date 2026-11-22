import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../../i18n";
import UpdateErrorText from "./UpdateErrorText";
import { DESKTOP_VERSION } from "../../lib/desktopRelease";
import { closeSettings } from "../../lib/settingsDialog";
import { readAutoCheck, writeAutoCheck } from "../../lib/updatePrefs";
import { checkClass, secondaryButton } from "../../styles/ui";

type Result = { kind: "latest" } | { kind: "available"; version: string } | { kind: "error"; error: unknown };

/** The updater module, imported on demand so this stays light and the web bundle never carries it. */
const loadUpdates = () => import("../../lib/desktopUpdate");

/**
 * Desktop update settings (in the settings dialog): the automatic check toggle, "Check now", and the
 * last background check's failure, if any.
 */
export default function UpdateSettings() {
  const t = useT("common");
  const [auto, setAuto] = useState(readAutoCheck);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [lastAutoError, setLastAutoError] = useState<unknown>(null);
  const hintId = useId();

  // Follow the background checks' last failure (cleared by the next successful check).
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let live = true;
    loadUpdates()
      .then((updates) => {
        if (!live) return;
        const sync = () => setLastAutoError(updates.getUpdateView().lastAutoError ?? null);
        sync();
        unsubscribe = updates.subscribeUpdate(sync);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  const toggle = (on: boolean) => {
    setAuto(on);
    writeAutoCheck(on);
  };

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      const updates = await loadUpdates();
      const found = await updates.checkNow();
      const version = updates.getUpdateView().version;
      setResult(found === "available" && version ? { kind: "available", version } : { kind: "latest" });
    } catch (e) {
      setResult({ kind: "error", error: e });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div data-update-settings className="border-t border-line p-6">
      <p className="eyebrow">{t("updateSettingsTitle")}</p>
      <label className="mt-3 flex items-start gap-3 text-sm text-ink">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => toggle(e.target.checked)}
          aria-describedby={hintId}
          className={`mt-0.5 ${checkClass}`}
        />
        {t("updateAutoLabel")}
      </label>
      <p id={hintId} className="mt-1 pl-7 text-xs text-ink-2">
        {t("updateAutoHint")}
      </p>
      {lastAutoError !== null && result === null && (
        <p data-last-auto-error className="mt-3 text-xs text-danger">
          {t("updateLastAutoFailed")} <UpdateErrorText error={lastAutoError} onNavigate={closeSettings} />
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" onClick={checkNow} disabled={checking} className={`h-9 gap-2 px-4 text-xs ${secondaryButton}`}>
          {checking && <Loader2 aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />}
          {checking ? t("updateChecking") : t("updateCheckNow")}
        </button>
        <p role="status" className={`text-xs ${result?.kind === "error" ? "text-danger" : "text-ink-2"}`}>
          {result?.kind === "latest" && t("updateUpToDate", { version: DESKTOP_VERSION })}
          {result?.kind === "available" && t("updateFound", { version: result.version })}
          {result?.kind === "error" && <UpdateErrorText error={result.error} onNavigate={closeSettings} />}
        </p>
      </div>
    </div>
  );
}
