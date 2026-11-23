import PixelIcon from "../brand/PixelIcon";
import FaqList from "./FaqList";
import { Link, useDictionary, useT } from "../../i18n";
import { toolById, type ToolId } from "../../lib/tools";
import { relatedTools, toolGuide } from "../../seo/guide";
import { guide as g } from "../../seo/guideStyles";

/**
 * "How it works" at the bottom of every tool page: the steps, the FAQ and the other tools of the
 * section. The prerendered page (src/seo/staticPage.ts) carries the same content for crawlers.
 */
export default function ToolGuide({ tool }: { tool: ToolId }) {
  const t = useT("howto");
  const th = useT("home");
  const content = toolGuide(useDictionary(), tool);
  const related = relatedTools(tool);
  return (
    <section data-testid="tool-guide" aria-labelledby="guide-title" className={g.section}>
      <p className={g.eyebrow}>{t("eyebrow")}</p>
      <h2 id="guide-title" className={g.title}>
        {content.howTo}
      </h2>
      <p className={g.lead}>{content.what}</p>
      <ol className={g.steps}>
        {content.steps.map((step, i) => (
          <li key={step} id={`step-${i + 1}`} className={g.step}>
            <span className={g.stepNumber}>{String(i + 1).padStart(2, "0")}</span>
            <span className={g.stepText}>{step}</span>
          </li>
        ))}
      </ol>

      <h2 id="faq" className={g.subTitle}>
        {t("faq")}
      </h2>
      <FaqList items={content.faq} />

      {related.length > 0 && (
        <>
          <h2 className={g.subTitle}>{t("related")}</h2>
          <ul className={g.related}>
            {related.map((id) => (
              <li key={id} className={g.relatedItem}>
                <Link to={toolById(id).href} className={g.relatedLink}>
                  <PixelIcon icon={toolById(id).pixel} className="h-4 w-4 shrink-0" />
                  <span>{th(`${id}.title`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
