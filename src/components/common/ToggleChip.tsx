import type { ReactNode } from "react";
import { chipClass } from "../../styles/ui";

interface Props {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Extra classes (size or layout overrides). */
  className?: string;
}

/** A toggle chip (format, scale, colour, language, layout): hairline when off, ink-filled and aria-pressed when on. */
export default function ToggleChip({ on, onClick, children, className = "" }: Props) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`${chipClass(on)} ${className}`}>
      {children}
    </button>
  );
}
