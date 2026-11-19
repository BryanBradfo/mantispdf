import ToolCell from "./ToolCell";
import { useT } from "../../i18n";
import { SECTIONS, sectionNumber, toolsIn } from "../../lib/tools";

/** The five tool sections (spec 3.6), each a mono numbered heading and a hairline grid of cells. */
export default function ToolGrid() {
  const t = useT("home");
  return (
    <div>
      {SECTIONS.map((section) => {
        const tools = toolsIn(section);
        return (
          <section
            key={section}
            aria-labelledby={`section-${section}`}
            className="border-t border-line py-10 lg:grid lg:grid-cols-12 lg:gap-8 lg:py-16"
          >
            <div className="mb-6 flex items-baseline justify-between lg:col-span-3 lg:mb-0 lg:block lg:self-start lg:sticky lg:top-8">
              <h2 id={`section-${section}`} className="font-mono text-xs uppercase tracking-[0.08em] text-ink">
                <span aria-hidden="true" className="text-ink-2">
                  {sectionNumber(section)} /{" "}
                </span>
                {t(`sections.${section}`)}
              </h2>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2 lg:mt-3">
                {t("sectionCount", { count: tools.length })}
              </p>
            </div>
            <ul className="grid grid-cols-1 pl-px pt-px sm:grid-cols-2 lg:col-span-9 xl:grid-cols-3">
              {tools.map(({ id, href, icon }, i) => (
                <ToolCell
                  key={id}
                  href={href}
                  icon={icon}
                  index={String(i + 1).padStart(2, "0")}
                  title={t(`${id}.title`)}
                  description={t(`${id}.desc`)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
