import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import type { LicenseStatus } from "../../hooks/useLicense";
import { useDescribeError, useT, type UiError } from "../../i18n";
import ErrorText from "../common/ErrorText";
import { focusRing, inputClass, linkClass, primaryButton, secondaryButton } from "../../styles/ui";

/** 150 ms fades; the panel also rises 8 px unless reduced motion is asked for. */
const FADE = { duration: 0.15, ease: "easeOut" } as const;

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
          transition={FADE}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-paper/80"
            onClick={onClose}
            aria-hidden
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t("licenseDialog")}
            initial={{ opacity: 0, ...rise }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, ...rise }}
            transition={FADE}
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
                    {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
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
                      {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
