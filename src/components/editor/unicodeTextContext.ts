import { createContext, useContext } from "react";
import type { FontManifest } from "../../lib/fonts/manifest";
import type { CjkFlavour } from "../../lib/fonts/select";
import type { TextLayout } from "../../lib/fonts/jobFonts";

export interface LayoutRequest {
  fonts: string[];
  text: string;
  size: number;
  width: number;
  height: number;
  align: string;
  lineHeight: number;
}

/** What the editor needs to preview embedded-font text: the manifest once loaded, and the engine layout. */
export interface UnicodeTextEnv {
  manifest: FontManifest | null;
  cjk: CjkFlavour;
  layoutText: (request: LayoutRequest) => Promise<TextLayout>;
  /** Grow text box `id` to `height` points (top edge fixed): its engine layout needs it. */
  fit?: (id: string, height: number) => void;
}

export const UnicodeTextContext = createContext<UnicodeTextEnv | null>(null);

export function useUnicodeText(): UnicodeTextEnv | null {
  return useContext(UnicodeTextContext);
}
