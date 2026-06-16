import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Plus } from "lucide-react";

/**
 * Custom window title bar for the Tauri desktop shell.
 *
 * Renders ONLY inside Tauri: in the web app `isTauri()` is false and this
 * returns null, so browser visitors never see fake desktop window controls.
 * The OS title bar is hidden (`decorations: false` in tauri.conf.json), so this
 * provides the draggable region (`data-tauri-drag-region`) and the macOS-style
 * traffic-light controls, driven by the Tauri v2 window API.
 */
export default function TitleBar() {
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
      className="sticky top-0 z-[60] flex h-9 shrink-0 select-none items-center border-b border-zinc-200 bg-zinc-50/90 backdrop-blur dark:border-white/10 dark:bg-[#0a0a0a]/90"
    >
      {/* macOS traffic-light controls (left). The `group` drives hover glyphs. */}
      <div className="group flex items-center gap-2 pl-3.5">
        <button
          onClick={() => appWindow.close()}
          aria-label="Close window"
          className="flex h-3 w-3 items-center justify-center rounded-full bg-[#ff5f57] ring-1 ring-inset ring-black/10 transition hover:brightness-95"
        >
          <X className="h-2 w-2 text-black/60 opacity-0 group-hover:opacity-100" strokeWidth={3.5} />
        </button>
        <button
          onClick={() => appWindow.minimize()}
          aria-label="Minimize window"
          className="flex h-3 w-3 items-center justify-center rounded-full bg-[#febc2e] ring-1 ring-inset ring-black/10 transition hover:brightness-95"
        >
          <Minus className="h-2 w-2 text-black/60 opacity-0 group-hover:opacity-100" strokeWidth={3.5} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          aria-label={maximized ? "Restore window" : "Maximize window"}
          className="flex h-3 w-3 items-center justify-center rounded-full bg-[#28c840] ring-1 ring-inset ring-black/10 transition hover:brightness-95"
        >
          <Plus className="h-2 w-2 text-black/60 opacity-0 group-hover:opacity-100" strokeWidth={3.5} />
        </button>
      </div>

      {/* Centered window title (drag passes through — pointer-events-none). */}
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-x-0 flex justify-center"
      >
        <span className="font-mono text-xs tracking-tight text-zinc-400 dark:text-zinc-600">
          MantisPDF
        </span>
      </div>

      {/* Right drag spacer; mirrors the controls' width so the title stays centered. */}
      <div data-tauri-drag-region className="ml-auto h-full w-[72px]" />
    </div>
  );
}
