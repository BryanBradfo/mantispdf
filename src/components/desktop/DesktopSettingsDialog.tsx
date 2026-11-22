import { useSyncExternalStore } from "react";
import LicenseDialog from "../license/LicenseDialog";
import { CHECKOUT_URL, useLicense } from "../../hooks/useLicense";
import { closeSettings, getSettingsDialog, subscribeSettingsDialog } from "../../lib/settingsDialog";

/**
 * The one desktop settings dialog (license + updates), opened through `openSettings()` from the home
 * page's Pro button, the title bar's gear and the update banner. Mounted by App in Tauri only.
 */
export default function DesktopSettingsDialog() {
  const license = useLicense();
  const { open, section } = useSyncExternalStore(subscribeSettingsDialog, getSettingsDialog);
  return (
    <LicenseDialog
      open={open}
      focusSection={section}
      onClose={closeSettings}
      status={license.status}
      onActivate={license.activate}
      onDeactivate={license.deactivate}
      checkoutUrl={CHECKOUT_URL}
    />
  );
}
