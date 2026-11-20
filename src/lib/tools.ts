import { PIXEL_ICONS, type PixelGlyph } from "./pixelIcons";

/** Tool ids name the `home` keys `<id>.title` and `<id>.desc`. */
export type ToolId =
  | "merge" | "split" | "organize" | "rotate" | "removePages" | "extractPages" | "crop" | "resize" | "nUp"
  | "compress" | "pdfToImage" | "imagesToPdf" | "extractImages"
  | "editPdf" | "fillForm" | "sign" | "watermark" | "pageNumbers" | "headerFooter" | "bates"
  | "encrypt" | "unlock" | "redact" | "sanitize" | "removeMetadata" | "editMetadata"
  | "ocr" | "compare";

/** Section ids name the `home` keys `sections.<id>`. */
export type SectionId = "organize" | "convert" | "edit" | "security" | "analyze";

export interface Tool {
  id: ToolId;
  /** English (root) path; `Link` from `../i18n` adds the locale prefix. */
  href: string;
  section: SectionId;
  /** The tool's hand-drawn 16x16 icon (`PixelIcon`), from `PIXEL_ICONS`. */
  pixel: PixelGlyph;
}

export const SECTIONS: readonly SectionId[] = ["organize", "convert", "edit", "security", "analyze"];

/** Id, path and section of every tool, in spec 3.6 order. */
const TABLE: readonly Omit<Tool, "pixel">[] = [
  { id: "merge", href: "/merge", section: "organize" },
  { id: "split", href: "/split", section: "organize" },
  { id: "organize", href: "/organize", section: "organize" },
  { id: "rotate", href: "/rotate", section: "organize" },
  { id: "removePages", href: "/remove-pages", section: "organize" },
  { id: "extractPages", href: "/extract-pages", section: "organize" },
  { id: "crop", href: "/crop", section: "organize" },
  { id: "resize", href: "/resize", section: "organize" },
  { id: "nUp", href: "/n-up", section: "organize" },

  { id: "compress", href: "/compress", section: "convert" },
  { id: "pdfToImage", href: "/pdf-to-image", section: "convert" },
  { id: "imagesToPdf", href: "/images-to-pdf", section: "convert" },
  { id: "extractImages", href: "/extract-images", section: "convert" },

  { id: "editPdf", href: "/edit-pdf", section: "edit" },
  { id: "fillForm", href: "/fill-form", section: "edit" },
  { id: "sign", href: "/sign", section: "edit" },
  { id: "watermark", href: "/watermark", section: "edit" },
  { id: "pageNumbers", href: "/page-numbers", section: "edit" },
  { id: "headerFooter", href: "/header-footer", section: "edit" },
  { id: "bates", href: "/bates", section: "edit" },

  { id: "encrypt", href: "/encrypt", section: "security" },
  { id: "unlock", href: "/unlock", section: "security" },
  { id: "redact", href: "/redact", section: "security" },
  { id: "sanitize", href: "/sanitize", section: "security" },
  { id: "removeMetadata", href: "/remove-metadata", section: "security" },
  { id: "editMetadata", href: "/edit-metadata", section: "security" },

  { id: "ocr", href: "/ocr", section: "analyze" },
  { id: "compare", href: "/compare", section: "analyze" },
];

/** The single source for the home grid, the header TOOLS menu and the tool-page eyebrow (spec 3.6 order). */
export const TOOLS: readonly Tool[] = TABLE.map((t) => ({ ...t, pixel: PIXEL_ICONS[t.id] }));

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function toolById(id: ToolId): Tool {
  return BY_ID.get(id)!;
}

/** The tools of one section, in table order. */
export function toolsIn(section: SectionId): Tool[] {
  return TOOLS.filter((t) => t.section === section);
}

/** "01" .. "05": the section's place in SECTIONS, for the mono `NN / SECTION` labels. */
export function sectionNumber(section: SectionId): string {
  return String(SECTIONS.indexOf(section) + 1).padStart(2, "0");
}
