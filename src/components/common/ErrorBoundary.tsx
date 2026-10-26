import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../../i18n";

function CrashNotice() {
  const t = useT("common");
  return (
    <div role="alert" className="mx-auto flex min-h-[40vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="text-lg font-semibold text-gray-900 dark:text-[#e5e5e5]">{t("crashTitle")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 rounded-lg bg-mantis-500 px-4 py-2 font-medium text-white hover:bg-mantis-600"
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
