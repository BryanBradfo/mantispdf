import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import type { LicenseStatus } from "../../hooks/useLicense";

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
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPro = status.tier === "pro";

  const activate = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onActivate(key);
      setKey("");
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
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
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="MantisPDF Pro license"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#0f0f0f]"
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/5 dark:hover:text-zinc-200"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent-deep dark:text-accent">
                <Sparkles className="h-5 w-5" strokeWidth={1.75} />
              </div>

              {isPro ? (
                <>
                  <h2 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                    MantisPDF Pro is active
                  </h2>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    Math OCR and the live LaTeX preview are unlocked. Thank you for
                    supporting local-first software.
                  </p>
                  {status.key_masked && (
                    <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 font-mono text-xs text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300">
                      <Check className="h-3.5 w-3.5 text-accent-deep dark:text-accent" />
                      {status.key_masked}
                    </p>
                  )}
                  <button
                    onClick={deactivate}
                    disabled={busy}
                    className="mt-5 inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 disabled:opacity-50 dark:border-white/10 dark:text-zinc-300 dark:hover:text-white"
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Deactivate on this device
                  </button>
                </>
              ) : (
                <>
                  <h2 className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                    Unlock MantisPDF Pro
                  </h2>
                  <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    Pro adds offline math OCR — convert equations to perfect LaTeX,
                    rendered live. Enter your license key to activate.
                  </p>

                  <div className="mt-5">
                    <input
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && activate()}
                      placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-accent/70 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                    />
                    {error && (
                      <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>
                    )}
                    <button
                      onClick={activate}
                      disabled={busy || !key.trim()}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-black shadow-glow transition-all hover:bg-accent-soft hover:shadow-glow-lg disabled:pointer-events-none disabled:opacity-40"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      {busy ? "Activating…" : "Activate license"}
                    </button>
                  </div>

                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 block text-center text-xs text-zinc-500 transition-colors hover:text-accent-deep dark:text-zinc-400 dark:hover:text-accent"
                  >
                    Don&apos;t have a key? Get MantisPDF Pro →
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
