import { Component, type ErrorInfo, type ReactNode } from "react";
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
  }

  render() {
    return this.state.error ? <CrashNotice /> : this.props.children;
  }
}
