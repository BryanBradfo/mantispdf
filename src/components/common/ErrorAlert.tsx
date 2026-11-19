import { useT, type UiError } from "../../i18n";
import { CircleAlert } from "lucide-react";
import ErrorText from "./ErrorText";
import { focusRing } from "../../pages/ToolShell";

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
      className={`flex items-start gap-3 border border-danger bg-surface px-4 py-3 text-sm text-danger${className ? ` ${className}` : ""}`}
    >
      <CircleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <ErrorText error={error} />
        {onDismiss && (
          <button onClick={onDismiss} className={`ml-4 underline underline-offset-4 ${focusRing}`}>
            {t("dismiss")}
          </button>
        )}
      </div>
    </div>
  );
}
