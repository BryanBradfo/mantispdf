import { useT, type UiError } from "../../i18n";

/** An error's message, with the raw engine text folded into a `<details>` when there is one. */
export default function ErrorText({ error }: { error: UiError }) {
  const t = useT("common");
  if (typeof error === "string") return <>{error}</>;
  return (
    <>
      {error.message}
      {error.details && (
        <details className="mt-1 text-xs opacity-80">
          <summary className="cursor-pointer">{t("errorDetails")}</summary>
          {error.details}
        </details>
      )}
    </>
  );
}
