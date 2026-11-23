import { ChevronDown } from "lucide-react";
import { guide as g } from "../../seo/guideStyles";
import type { QA } from "../../seo/guide";

/** Questions as a <details> list: each summary is a button (Enter or Space opens it), the answer below. */
export default function FaqList({ items }: { items: QA[] }) {
  return (
    <div className={g.faqList}>
      {items.map(({ q, a }) => (
        <details key={q} className={g.faqItem}>
          <summary className={g.faqSummary}>
            <h3 className={g.faqQuestion}>{q}</h3>
            <ChevronDown aria-hidden="true" strokeWidth={1.5} className={g.faqChevron} />
          </summary>
          <p className={g.faqAnswer}>{a}</p>
        </details>
      ))}
    </div>
  );
}
