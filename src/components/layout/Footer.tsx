import { useT } from "../../i18n";
import { MantisHead } from "../brand/MantisHead";
import { GithubMark } from "../brand/GithubMark";
import { focusRing } from "../../styles/ui";

const GITHUB_URL = "https://github.com/BryanBradfo/mantispdf";

export default function Footer() {
  const t = useT("common");
  return (
    <footer className="border-t border-line bg-paper">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
        <div className="flex items-start gap-3">
          <MantisHead className="mt-0.5 h-5 w-auto shrink-0 text-ink-2" />
          <p className="max-w-md text-sm leading-relaxed text-ink-2">{t("footerPrivacy")}</p>
        </div>
        <div className="flex items-center gap-6 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2">
          <span>{t("footerLicense")}</span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-2 hover:text-ink ${focusRing}`}
          >
            <GithubMark className="h-3.5 w-3.5" />
            {t("footerGithub")}
          </a>
        </div>
      </div>
    </footer>
  );
}
