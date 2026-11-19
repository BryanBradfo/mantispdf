import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Plus } from "lucide-react";
import { useT } from "../../i18n";
import { MantisHead } from "../brand/MantisHead";
import { focusRing } from "../../styles/ui";

/** A window control: a round (round by nature, like the OS ones) hairline button that fills with ink on hover. */
const control = `flex h-3 w-3 items-center justify-center rounded-full border border-line-strong text-ink hover:border-ink hover:bg-ink hover:text-paper ${focusRing} focus-visible:!ring-offset-1`;
const glyph = "h-2 w-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

/**
 * Custom window title bar for the Tauri desktop shell.
 *
 * Renders ONLY inside Tauri: in the web app `isTauri()` is false and this
 * returns null, so browser visitors never see fake desktop window controls.
 * The OS title bar is hidden (`decorations: false` in tauri.conf.json), so this
 * provides the draggable region (`data-tauri-drag-region`) and the macOS-style
 * window controls (close, minimize, maximize), driven by the Tauri v2 window API.
 */
export default function TitleBar() {
  const t = useT("common");
  const desktop = isTauri();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    // Keep the maximize/restore state in sync when the user resizes via the OS.
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [desktop]);

  if (!desktop) return null;

  const appWindow = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="sticky top-0 z-[60] flex h-9 shrink-0 select-none items-center border-b border-line bg-paper"
    >
      {/* Window controls (left, where macOS puts them): hollow rounds, glyphs on hover or focus. */}
      <div className="group flex items-center gap-2 pl-3.5">
        <button onClick={() => appWindow.close()} aria-label={t("windowClose")} className={control}>
          <X className={glyph} strokeWidth={3} />
        </button>
        <button onClick={() => appWindow.minimize()} aria-label={t("windowMinimize")} className={control}>
          <Minus className={glyph} strokeWidth={3} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          aria-label={maximized ? t("windowRestore") : t("windowMaximize")}
          className={control}
        >
          <Plus className={glyph} strokeWidth={3} />
        </button>
      </div>

      {/* Centered window title (drag passes through: pointer-events-none). */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2 text-ink-2"
      >
        <MantisHead className="h-4 w-auto" />
        <span className="font-display text-xs font-medium uppercase tracking-wider">MantisPDF</span>
      </div>

      {/* Right drag spacer; mirrors the controls' width so the title stays centered. */}
      <div data-tauri-drag-region className="ml-auto h-full w-[72px]" />
    </div>
  );
}
