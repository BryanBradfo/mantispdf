import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Mirrors the Rust `LicenseStatus` (ADR 03). */
export interface LicenseStatus {
  tier: "pro" | "free";
  status: string;
  key_masked?: string | null;
}

/** Lemon Squeezy checkout/permalink for the "Upgrade to Pro" CTA. */
export const CHECKOUT_URL: string =
  import.meta.env.VITE_MANTIS_CHECKOUT_URL ?? "https://lemonsqueezy.com";

// The web build has no backend, so it's treated as a marketing demo: license
// state is irrelevant there (the desktop app is the paid product).
const WEB_STATUS: LicenseStatus = { tier: "free", status: "web" };

/**
 * Frontend view of the backend-enforced license. The backend is the source of
 * truth (ADR 03); this hook only reflects it so the UI can show/hide Pro
 * features. On the web (non-Tauri) it reports a demo "free" status.
 */
export function useLicense() {
  const [status, setStatus] = useState<LicenseStatus>(WEB_STATUS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setStatus(WEB_STATUS);
      setLoading(false);
      return;
    }
    try {
      setStatus(await invoke<LicenseStatus>("get_license_status"));
    } catch {
      setStatus({ tier: "free", status: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Activate a key; throws (with the backend's message) on failure. */
  const activate = useCallback(async (key: string): Promise<LicenseStatus> => {
    const s = await invoke<LicenseStatus>("activate_license", { key: key.trim() });
    setStatus(s);
    return s;
  }, []);

  const deactivate = useCallback(async () => {
    await invoke("deactivate_license");
    await refresh();
  }, [refresh]);

  return {
    status,
    isPro: status.tier === "pro",
    // Pro features are shown on the web demo (showcase) and for licensed desktop
    // users; gated only for an unlicensed desktop app.
    locked: isTauri() && status.tier !== "pro",
    onDesktop: isTauri(),
    loading,
    activate,
    deactivate,
    refresh,
  };
}
