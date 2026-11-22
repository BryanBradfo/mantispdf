import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useDescribeError, useT, type UiError } from "../../i18n";
import ErrorText from "../common/ErrorText";
import { DESKTOP_VERSION } from "../../lib/desktopRelease";
import { readAutoCheck, writeAutoCheck } from "../../lib/updatePrefs";
import { checkClass, secondaryButton } from "../../styles/ui";

type Result = { kind: "latest" } | { kind: "available"; version: string } | { kind: "error"; error: UiError };

/**
 * Desktop update settings (in the license dialog): the automatic check toggle and "Check now". The
 * updater module is imported on demand, so this stays light and the web bundle never carries it.
 */
export default function UpdateSettings() {
  const t = useT("common");
  const describe = useDescribeError();
  const [auto, setAuto] = useState(readAutoCheck);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const hintId = useId();

  const toggle = (on: boolean) => {
    setAuto(on);
    writeAutoCheck(on);
  };

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      const updates = await import("../../lib/desktopUpdate");
      const found = await updates.checkNow();
      const version = updates.getUpdateView().version;
      setResult(found === "available" && version ? { kind: "available", version } : { kind: "latest" });
    } catch (e) {
      setResult({ kind: "error", error: describe(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="border-t border-line p-6">
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
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" onClick={checkNow} disabled={checking} className={`h-9 gap-2 px-4 text-xs ${secondaryButton}`}>
          {checking && <Loader2 aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />}
          {checking ? t("updateChecking") : t("updateCheckNow")}
        </button>
        <p role="status" className={`text-xs ${result?.kind === "error" ? "text-danger" : "text-ink-2"}`}>
          {result?.kind === "latest" && t("updateUpToDate", { version: DESKTOP_VERSION })}
          {result?.kind === "available" && t("updateFound", { version: result.version })}
          {result?.kind === "error" && <ErrorText error={result.error} />}
        </p>
      </div>
    </div>
  );
}
