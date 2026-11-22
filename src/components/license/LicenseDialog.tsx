import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import type { LicenseStatus } from "../../hooks/useLicense";
import UpdateSettings from "../desktop/UpdateSettings";
import { useDescribeError, useT, type UiError } from "../../i18n";
import ErrorText from "../common/ErrorText";
import { focusRing, inputClass, linkClass, primaryButton, secondaryButton } from "../../styles/ui";

/** 150 ms fade and 8 px rise; nothing moves or fades under reduced motion. */
const FADE = { duration: 0.15, ease: "easeOut" } as const;
const INSTANT = { duration: 0 } as const;

/** The controls Tab can reach inside the dialog, in order. */
function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
}

interface LicenseDialogProps {
  open: boolean;
  onClose: () => void;
  status: LicenseStatus;
  onActivate: (key: string) => Promise<LicenseStatus>;
  onDeactivate: () => Promise<void>;
  checkoutUrl: string;
}

export default function LicenseDialog({
  open,
  onClose,
  status,
  onActivate,
  onDeactivate,
  checkoutUrl,
}: LicenseDialogProps) {
  const t = useT("common");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const describe = useDescribeError();
  const [error, setError] = useState<UiError | null>(null);

  const isPro = status.tier === "pro";
  const errorId = useId();
  const still = useReducedMotion();
  const rise = still ? {} : { y: 8 };
  const transition = still ? INSTANT : FADE;
  const panelRef = useRef<HTMLDivElement>(null);

  // A modal: focus moves in on open (the key input, else the first control) and back to the
  // control that opened it on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // The key input (not the update settings' checkbox, desktop only), else the first control.
    (panel?.querySelector<HTMLElement>('input:not([disabled]):not([type="checkbox"])') ?? focusables(panel)[0])?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  /** Escape closes; Tab and Shift+Tab cycle inside the dialog. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables(panelRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !items.includes(active as HTMLElement))) {
      e.preventDefault();
      first.focus();
    }
  };

  const activate = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onActivate(key);
      setKey("");
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDeactivate();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-paper/80"
            onClick={onClose}
            aria-hidden
          />

          <motion.div
            ref={panelRef}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label={t("licenseDialog")}
            initial={{ opacity: 0, ...rise }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, ...rise }}
            transition={transition}
            className="relative w-full max-w-md rounded-none border border-line-strong bg-paper"
          >
            <button
              onClick={onClose}
              aria-label={t("close")}
              className={`absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-none text-ink-2 hover:text-ink ${focusRing}`}
            >
              <X aria-hidden="true" strokeWidth={1.5} className="h-4 w-4" />
            </button>

            <div className="p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-none border border-line-strong text-ink">
                <Sparkles aria-hidden="true" className="h-5 w-5" strokeWidth={1.5} />
              </div>

              {isPro ? (
                <>
                  <h2 className="mt-5 font-display text-2xl font-light tracking-[-0.01em] text-ink">
                    {t("licenseActiveTitle")}
                  </h2>
                  <p className="mt-2 text-sm text-ink-2">
                    {t("licenseActiveBody")}
                  </p>
                  {status.key_masked && (
                    <p className="mt-4 inline-flex items-center gap-2 rounded-none border border-line bg-surface px-3 py-1.5 font-mono text-xs text-ink">
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      {status.key_masked}
                    </p>
                  )}
                  <button
                    onClick={deactivate}
                    disabled={busy}
                    className={`mt-5 gap-2 ${secondaryButton}`}
                  >
                    {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                    {t("licenseDeactivate")}
                  </button>
                </>
              ) : (
                <>
                  <h2 className="mt-5 font-display text-2xl font-light tracking-[-0.01em] text-ink">
                    {t("licenseUnlockTitle")}
                  </h2>
                  <p className="mt-2 text-sm text-ink-2">
                    {t("licenseUnlockBody")}
                  </p>

                  <div className="mt-5">
                    <input
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && activate()}
                      placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t("licenseKey")}
                      aria-invalid={error !== null}
                      aria-describedby={error ? errorId : undefined}
                      className={`${inputClass} !mt-0 font-mono ${error ? "!border-danger" : ""}`}
                    />
                    {error && (
                      <div id={errorId} role="alert" className="mt-2 text-xs text-danger">
                        <ErrorText error={error} />
                      </div>
                    )}
                    <button
                      onClick={activate}
                      disabled={busy || !key.trim()}
                      className={`mt-3 w-full gap-2 ${primaryButton}`}
                    >
                      {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                      {busy ? t("licenseActivating") : t("licenseActivate")}
                    </button>
                  </div>

                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`mt-5 block w-fit text-xs ${linkClass} mx-auto`}
                  >
                    {t("licenseGetKey")}
                  </a>
                </>
              )}
            </div>
            {/* The desktop app's only settings live here: automatic updates. */}
            {isTauri() && <UpdateSettings />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
