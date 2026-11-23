import { Component, type ErrorInfo, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { isStaleCodeError, reportStaleCode } from "../../pwa/swUpdate";
import { useT } from "../../i18n";
import { primaryButton } from "../../styles/ui";

function CrashNotice() {
  const t = useT("common");
  return (
    <div role="alert" className="mx-auto flex min-h-[40vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="font-display text-2xl font-light text-ink">{t("crashTitle")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className={`mt-6 ${primaryButton}`}
      >
        {t("crashReload")}
      </button>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** A new value (e.g. the pathname) clears a caught error, so navigating away recovers. */
  resetKey?: string;
  /** Render nothing instead of the crash notice (an optional extra, like the desktop update panel). */
  silent?: boolean;
}

/**
 * A chunk of an older deploy that the server no longer has (an old tab), while online on the web: the update
 * panel's "new version is ready" with Reload replaces the crash notice. The desktop app has no such panel.
 */
function staleCode(error: unknown): boolean {
  return isStaleCodeError(error) && navigator.onLine !== false && !isTauri();
}

/** Catches a render error (or a lazy chunk that fails to load) so the app never goes blank. */
export default class ErrorBoundary extends Component<Props, { error: unknown; key?: string }> {
  state: { error: unknown; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: { error: unknown; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
    if (staleCode(error)) reportStaleCode();
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (staleCode(this.state.error)) return null;
    return this.props.silent ? null : <CrashNotice />;
  }
}
