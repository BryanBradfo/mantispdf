interface ErrorAlertProps {
  error: string | null;
  onDismiss?: () => void;
  className?: string;
}

export default function ErrorAlert({ error, onDismiss, className }: ErrorAlertProps) {
  if (!error) return null;
  return (
    <div
      className={`rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400${className ? ` ${className}` : ""}`}
    >
      {error}
      {onDismiss && (
        <button onClick={onDismiss} className="ml-4 underline">
          Dismiss
        </button>
      )}
    </div>
  );
}
