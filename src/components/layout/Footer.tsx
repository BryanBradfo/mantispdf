import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link, useT } from "../../i18n";
import { MantisHead } from "../brand/MantisHead";
import { GithubMark } from "../brand/GithubMark";
import { FOOTER_MANTIS } from "../brand/footerMantis";
import { SECTIONS, toolsIn } from "../../lib/tools";
import { focusRing } from "../../styles/ui";

const GITHUB_URL = "https://github.com/BryanBradfo/mantispdf";

/** Desktop columns (brand, one per tools section, project) on one row, shared by the links and the bottom row so both line up. */
const columnsXl = "xl:grid-cols-[minmax(0,1.15fr)_repeat(6,minmax(0,1fr))]";

/** The dithered mantis, drawn in faint ink through its 1-bit PNG as a CSS mask (one image for both themes). One
 *  image pixel is one dot: 1 CSS px on phones, 2 px from `sm` (the whole 672 px image then spans the 1344 px
 *  content width), always whole pixels so the Bayer pattern never beats. Centred on the head, the sides crop on
 *  narrower screens; a vertical gradient, intersected with the image, fades it out into the wordmark. */
const mantisMask = `url("${import.meta.env.BASE_URL}${FOOTER_MANTIS.src}"), linear-gradient(to bottom, black 30%, transparent 92%)`;
const mantisStyle = {
  height: `calc(var(--dot) * ${FOOTER_MANTIS.height})`,
  maskImage: mantisMask,
  WebkitMaskImage: mantisMask,
  maskSize: `calc(var(--dot) * ${FOOTER_MANTIS.width}) calc(var(--dot) * ${FOOTER_MANTIS.height}), 100% 100%`,
  WebkitMaskSize: `calc(var(--dot) * ${FOOTER_MANTIS.width}) calc(var(--dot) * ${FOOTER_MANTIS.height}), 100% 100%`,
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  maskPosition: "center top",
  WebkitMaskPosition: "center top",
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
  imageRendering: "pixelated",
} as const;

/** Mono uppercase micro-label (column eyebrows, bottom row). */
const micro = "font-mono text-[11px] uppercase tracking-[0.08em]";
/** Small uppercase, widely tracked Oswald link text, as in the header. */
const linkText = `inline-flex items-center gap-1.5 py-1 font-display text-[12px] font-normal uppercase leading-snug tracking-[0.12em] text-ink-2 xl:tracking-[0.08em] hover:text-ink ${focusRing}`;

function Group({ eyebrow, heading, id, children }: { eyebrow: string; heading: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <p aria-hidden="true" className={`${micro} text-ink-3`}>
        {eyebrow}
      </p>
      {/* Two lines tall, text at the bottom: one-word and two-line headings share a baseline and the lists start level. */}
      <h2
        id={id}
        className="mt-3 flex min-h-[2.1em] items-end text-balance font-display text-[26px] font-light leading-[1.05] tracking-[-0.005em] text-ink xl:text-[26px]"
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
        <div
          aria-hidden="true"
          data-testid="footer-mantis"
          style={mantisStyle}
          className="pointer-events-none -mb-[calc(100cqw/3.62*0.3)] bg-ink/25 [--dot:1px] sm:[--dot:2px] dark:bg-ink/[0.22]"
        />
        {/* Oswald 300 "MantisPDF" is 3.585 em wide: this size spans the content width at every viewport, with
            no scrollbar maths. The negative margin cancels the M's side bearing so the stem lines up with the columns. */}
        <p
          aria-hidden="true"
          data-testid="footer-wordmark"
          className="relative -ml-[0.04em] select-none whitespace-nowrap font-display text-[calc(100cqw/3.62)] font-light leading-[0.78] tracking-[-0.01em] text-line"
        >
          MantisPDF
        </p>

        {/* On wide screens (one row of columns) the columns climb onto the foot of the wordmark, as on the Hermes site. */}
        <nav aria-label={t("footerNav")} className={`relative mt-12 gap-y-14 sm:mt-16 xl:-mt-[calc(100cqw/3.62*0.16)] grid grid-cols-2 gap-x-6 sm:grid-cols-3 sm:gap-x-8 xl:gap-x-6 ${columnsXl}`}>
          <div className="col-span-2 sm:col-span-3 xl:col-span-1">
            <Link to="/" className={`inline-block text-ink ${focusRing}`}>
              <MantisHead title="MantisPDF" className="h-14 w-auto" />
            </Link>
            {/* One sentence a line in the narrow desktop brand column, never a break inside a sentence. */}
            <p className={`${micro} mt-6 text-ink`}>
              {t("footerSlogan")
                .split(/(?<=\.)\s+/)
                .map((sentence, i) => (
                  <span key={sentence} className="xl:block">
                    {i > 0 && " "}
                    {sentence}
                  </span>
                ))}
            </p>
            <p className="mt-3 max-w-[17rem] text-sm leading-relaxed text-ink-2">{t("footerPrivacy")}</p>
          </div>

          {SECTIONS.map((section) => (
            <Group key={section} eyebrow={t(`footerEyebrow.${section}`)} heading={th(`sections.${section}`)} id={`footer-${section}`}>
              {toolsIn(section).map(({ id, href }) => (
                <li key={id}>
                  <Link to={href} className={linkText}>
                    {th(`${id}.title`)}
                  </Link>
                </li>
              ))}
            </Group>
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
          className={`mt-20 flex flex-wrap items-center gap-x-8 gap-y-3 text-ink-3 sm:mt-24 xl:grid xl:gap-x-6 ${columnsXl} [&>p]:whitespace-nowrap ${micro}`}
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
