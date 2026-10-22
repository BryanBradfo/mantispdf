import { useT, type UiError } from "../../i18n";
import ErrorText from "./ErrorText";

interface ErrorAlertProps {
  error: UiError | null;
  onDismiss?: () => void;
  className?: string;
}

export default function ErrorAlert({ error, onDismiss, className }: ErrorAlertProps) {
  const t = useT("common");
  if (!error) return null;
  return (
    <div
      className={`rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400${className ? ` ${className}` : ""}`}
    >
      <ErrorText error={error} />
      {onDismiss && (
        <button onClick={onDismiss} className="ml-4 underline">
          {t("dismiss")}
        </button>
      )}
    </div>
  );
}
