import { Children, Fragment, type ReactNode } from "react";

/**
 * A row of separate facts ("PDF files", "up to 64 MB"): the items sit side by side with spacing, no
 * separator glyph. Screen readers get a visually hidden comma between items so the row does not
 * read as run-on words.
 */
export default function MetaItems({ children, className = "" }: { children: ReactNode; className?: string }) {
  const items = Children.toArray(children);
  return (
    <span className={`inline-flex flex-wrap justify-center gap-x-4 gap-y-1 ${className}`.trim()}>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sr-only">, </span>}
          <span>{item}</span>
        </Fragment>
      ))}
    </span>
  );
}
