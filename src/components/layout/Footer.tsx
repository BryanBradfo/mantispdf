import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link, useT } from "../../i18n";
import { MantisHead } from "../brand/MantisHead";
import { GithubMark } from "../brand/GithubMark";
import { sectionNumber, toolsIn, type SectionId } from "../../lib/tools";
import { focusRing } from "../../styles/ui";

const GITHUB_URL = "https://github.com/BryanBradfo/mantispdf";

/** Brand block, then one column per group (Recognize shares the Security column), then the project. */
const COLUMNS: readonly (readonly SectionId[])[] = [["organize"], ["convert"], ["edit"], ["security", "recognize"]];

/** Desktop columns (brand, four tool columns, project), shared by the links and the bottom row so both line up. */
const columnsXl = "xl:grid-cols-[minmax(0,1.5fr)_repeat(5,minmax(0,1fr))]";

/** Mono uppercase micro-label (column eyebrows, bottom row). */
const micro = "font-mono text-[11px] uppercase tracking-[0.08em]";
/** Small uppercase, widely tracked Oswald link text, as in the header. */
const linkText = `inline-flex items-center gap-1.5 py-1 font-display text-[12px] font-normal uppercase leading-snug tracking-[0.12em] text-ink-2 hover:text-ink ${focusRing}`;

function Group({ eyebrow, heading, id, children }: { eyebrow: string; heading: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <p aria-hidden="true" className={`${micro} text-ink-3`}>
        {eyebrow}
      </p>
      {/* Two lines tall, text at the bottom: one-word and two-line headings share a baseline and the lists start level. */}
      <h2
        id={id}
        className="mt-3 flex min-h-[2.1em] items-end text-balance font-display text-[26px] font-light leading-[1.05] tracking-[-0.005em] text-ink xl:text-[28px]"
      >
        {heading}
      </h2>
      <ul className="mt-5 space-y-1.5">{children}</ul>
    </section>
  );
}

function External({ href, children }: { href: string; children: ReactNode }) {
  const t = useT("common");
  return (
    <li>
      <a href={href} target="_blank" rel="noopener noreferrer" className={linkText}>
        {children}
        <ArrowUpRight aria-hidden="true" strokeWidth={1.5} className="h-3 w-3 text-ink-3" />
        <span className="sr-only"> {t("footerNewTab")}</span>
      </a>
    </li>
  );
}

export default function Footer() {
  const t = useT("common");
  const th = useT("home");
  const year = new Date().getFullYear();

  return (
    <footer className="bg-paper">
      {/* An inline-size container: `cqw` below is a hundredth of the content width, padding excluded. */}
      <div className="mx-auto max-w-[1440px] px-4 pb-10 pt-20 [container-type:inline-size] sm:px-8 sm:pt-28 lg:px-12">
        {/* Oswald 300 "MantisPDF" is 3.585 em wide: this size spans the content width at every viewport, with
            no scrollbar maths. The negative margin cancels the M's side bearing so the stem lines up with the columns. */}
        <p
          aria-hidden="true"
          data-testid="footer-wordmark"
          className="-ml-[0.04em] select-none whitespace-nowrap font-display text-[calc(100cqw/3.62)] font-light leading-[0.78] tracking-[-0.01em] text-line"
        >
          MantisPDF
        </p>

        {/* On wide screens (one row of columns) the columns climb onto the foot of the wordmark, as on the Hermes site. */}
        <nav aria-label={t("footerNav")} className={`relative mt-12 gap-y-14 sm:mt-16 xl:-mt-[calc(100cqw/3.62*0.16)] grid grid-cols-2 gap-x-6 sm:grid-cols-3 sm:gap-x-8 ${columnsXl}`}>
          <div className="col-span-2 sm:col-span-3 xl:col-span-1">
            <Link to="/" className={`inline-block text-ink ${focusRing}`}>
              <MantisHead title="MantisPDF" className="h-14 w-auto" />
            </Link>
            <p className={`${micro} mt-6 text-ink`}>{th("tagline")}</p>
            <p className="mt-3 max-w-[17rem] text-sm leading-relaxed text-ink-2">{t("footerPrivacy")}</p>
          </div>

          {COLUMNS.map((sections) => (
            <div key={sections[0]} className="space-y-12">
              {sections.map((section) => (
                <Group key={section} eyebrow={sectionNumber(section)} heading={th(`sections.${section}`)} id={`footer-${section}`}>
                  {toolsIn(section).map(({ id, href }) => (
                    <li key={id}>
                      <Link to={href} className={linkText}>
                        {th(`${id}.title`)}
                      </Link>
                    </li>
                  ))}
                </Group>
              ))}
            </div>
          ))}

          <Group eyebrow={t("footerOpenSource")} heading={t("footerProject")} id="footer-project">
            <External href={GITHUB_URL}>
              <span className="text-ink-3">{t("footerGoTo")}</span>
              {t("headerGithub")}
            </External>
            <External href={`${GITHUB_URL}/issues`}>{t("footerReportBug")}</External>
            <External href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>{t("footerContribute")}</External>
            <External href={`${GITHUB_URL}/blob/main/LICENSE`}>{t("footerLicense")}</External>
          </Group>
        </nav>

        <div
          className={`mt-20 flex flex-wrap items-center gap-x-8 gap-y-3 text-ink-3 sm:mt-24 xl:grid xl:gap-x-8 ${columnsXl} [&>p]:whitespace-nowrap ${micro}`}
        >
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("footerGithub")}
            className={`-ml-2 inline-flex h-9 w-9 items-center justify-center text-ink-2 hover:text-ink ${focusRing}`}
          >
            <GithubMark className="h-[18px] w-[18px]" />
          </a>
          {/* Phones: the icon gets a line of its own, the four labels wrap under it. */}
          <span aria-hidden="true" className="basis-full xl:hidden" />
          <p className="text-ink-2">{t("footerCopyright", { year })}</p>
          <p>{t("footerOpenSource")}</p>
          <p>{t("footerLicense")}</p>
          <p>{t("footerInBrowser")}</p>
        </div>
      </div>
    </footer>
  );
}
