import { LoaderCircle } from "lucide-react";
import { monoLabel } from "../../styles/ui";

/** A spinning line icon and a mono label, for "Loading PDF…" style waits. */
export default function LoadingRow({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-3 ${className}`}>
      <LoaderCircle aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 animate-spin text-ink-2" />
      <span className={monoLabel}>{label}</span>
    </div>
  );
}
