import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown, Menu, Moon, Sun, X } from "lucide-react";
import { Link, useT } from "../../i18n";
import { MantisHead } from "../brand/MantisHead";
import { GithubMark } from "../brand/GithubMark";
import LanguageSwitcher from "./LanguageSwitcher";
import ToolsMenu from "./ToolsMenu";
import { useTheme } from "../../hooks/useTheme";
import { focusRing } from "../../styles/ui";

const GITHUB_URL = "https://github.com/BryanBradfo/mantispdf";

/** Small uppercase, widely tracked header text (Oswald). */
const navText = "font-display text-[13px] font-normal uppercase tracking-[0.14em]";

export default function Header() {
  const t = useT("common");
  const [dark, setDark] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const menuId = useId();
  const headerRef = useRef<HTMLElement>(null);
  /** The button that opened the menu (TOOLS on desktop, MENU on phones): focus goes back to it on Escape. */
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // A followed link closes the menu.
  useEffect(() => setMenuOpen(false), [pathname]);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Escape closes and returns focus to the trigger; a click outside the header closes.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) closeMenu(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menuOpen, closeMenu]);

  const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = e.currentTarget;
    setMenuOpen((open) => !open);
  };

  const github = (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 py-1 text-ink-2 hover:text-ink ${navText} ${focusRing}`}
    >
      <GithubMark className="h-3.5 w-3.5" />
      {t("headerGithub")}
    </a>
  );

  return (
    <header
      ref={headerRef}
      // Focus leaving the header and its panel (Tab past the last tool) closes the menu. A null
      // relatedTarget (a click on plain text inside the panel) is ignored; outside clicks close via pointerdown.
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (menuOpen && next instanceof Node && !e.currentTarget.contains(next)) setMenuOpen(false);
      }}
      className="relative z-40 bg-paper"
    >
      <div className="mx-auto grid h-16 max-w-[1440px] grid-cols-[1fr_auto] items-center gap-4 px-4 sm:grid-cols-[1fr_auto_1fr] sm:px-8 lg:px-12">
        <div className="hidden sm:block">
          <button
            type="button"
            onClick={toggleMenu}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            className={`inline-flex items-center gap-1.5 py-1 ${navText} ${menuOpen ? "text-ink" : "text-ink-2 hover:text-ink"} ${focusRing}`}
          >
            {t("headerTools")}
            <ChevronDown
              aria-hidden="true"
              strokeWidth={1.5}
              className={`h-3.5 w-3.5 transition-transform duration-150 ${menuOpen ? "rotate-180" : ""}`}
            />
          </button>
        </div>

        <Link to="/" className={`flex items-center gap-2.5 justify-self-start text-ink sm:justify-self-center ${focusRing}`}>
          <MantisHead className="h-9 w-auto" />
          <span className="font-display text-[22px] font-light leading-none tracking-[-0.01em]">MantisPDF</span>
        </Link>

        <div className="flex items-center justify-end gap-1 sm:gap-6">
          <span className="hidden sm:inline-flex">{github}</span>
          <span className="hidden sm:flex">
            <LanguageSwitcher />
          </span>
          <button
            type="button"
            onClick={() => setDark(!dark)}
            aria-label={t("toggleDarkMode")}
            aria-pressed={dark}
            className={`flex h-9 w-9 items-center justify-center text-ink-2 hover:text-ink ${focusRing}`}
          >
            {dark ? (
              <Sun aria-hidden="true" strokeWidth={1.5} className="h-[18px] w-[18px]" />
            ) : (
              <Moon aria-hidden="true" strokeWidth={1.5} className="h-[18px] w-[18px]" />
            )}
          </button>
          <button
            type="button"
            onClick={toggleMenu}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={t("headerMenu")}
            className={`flex h-9 w-9 items-center justify-center text-ink sm:hidden ${focusRing}`}
          >
            {menuOpen ? (
              <X aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
            ) : (
              <Menu aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <ToolsMenu
          id={menuId}
          onNavigate={() => closeMenu(false)}
          mobileExtras={
            <>
              <LanguageSwitcher />
              {github}
            </>
          }
        />
      )}
    </header>
  );
}
