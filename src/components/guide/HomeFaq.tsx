import FaqList from "./FaqList";
import { useDictionary, useT } from "../../i18n";
import { homeFaq } from "../../seo/guide";
import { guide as g } from "../../seo/guideStyles";

/** The home page's questions and answers, above the footer. */
export default function HomeFaq() {
  const t = useT("howto");
  const items = homeFaq(useDictionary());
  return (
    <section id="faq" data-testid="home-faq" aria-labelledby="home-faq-title" className="scroll-mt-4 pb-24 lg:grid lg:grid-cols-12 lg:gap-8">
      <div className="mb-6 lg:col-span-3 lg:mb-0">
        <p className={g.eyebrow}>{t("faq")}</p>
      </div>
      <div className="lg:col-span-9">
        <h2 id="home-faq-title" className="font-display text-3xl font-light leading-tight tracking-[-0.01em] text-ink sm:text-4xl">
          {t("homeFaqTitle")}
        </h2>
        <div className="mt-6">
          <FaqList items={items} />
        </div>
      </div>
    </section>
  );
}
