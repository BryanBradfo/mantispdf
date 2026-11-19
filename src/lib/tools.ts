import {
  Combine,
  Crop,
  Eraser,
  EyeOff,
  FileImage,
  FileMinus,
  FileOutput,
  FoldVertical,
  Grid2x2,
  Hash,
  ImageDown,
  Images,
  LayoutGrid,
  ListOrdered,
  Lock,
  LockOpen,
  PanelsTopBottom,
  PenLine,
  RotateCw,
  Scaling,
  ScanText,
  Scissors,
  ShieldCheck,
  Signature,
  Stamp,
  Tags,
  TextCursorInput,
  type LucideIcon,
} from "lucide-react";

/** Tool ids name the `home` keys `<id>.title` and `<id>.desc`. */
export type ToolId =
  | "merge" | "split" | "organize" | "rotate" | "removePages" | "extractPages" | "crop" | "resize" | "nUp"
  | "compress" | "pdfToImage" | "imagesToPdf" | "extractImages"
  | "editPdf" | "fillForm" | "sign" | "watermark" | "pageNumbers" | "headerFooter" | "bates"
  | "encrypt" | "unlock" | "redact" | "sanitize" | "removeMetadata" | "editMetadata"
  | "ocr";

/** Section ids name the `home` keys `sections.<id>`. */
export type SectionId = "organize" | "convert" | "edit" | "security" | "recognize";

export interface Tool {
  id: ToolId;
  /** English (root) path; `Link` from `../i18n` adds the locale prefix. */
  href: string;
  section: SectionId;
  icon: LucideIcon;
}

export const SECTIONS: readonly SectionId[] = ["organize", "convert", "edit", "security", "recognize"];

/** The single source for the home grid, the header TOOLS menu and the tool-page eyebrow (spec 3.6 order). */
export const TOOLS: readonly Tool[] = [
  { id: "merge", href: "/merge", section: "organize", icon: Combine },
  { id: "split", href: "/split", section: "organize", icon: Scissors },
  { id: "organize", href: "/organize", section: "organize", icon: LayoutGrid },
  { id: "rotate", href: "/rotate", section: "organize", icon: RotateCw },
  { id: "removePages", href: "/remove-pages", section: "organize", icon: FileMinus },
  { id: "extractPages", href: "/extract-pages", section: "organize", icon: FileOutput },
  { id: "crop", href: "/crop", section: "organize", icon: Crop },
  { id: "resize", href: "/resize", section: "organize", icon: Scaling },
  { id: "nUp", href: "/n-up", section: "organize", icon: Grid2x2 },

  { id: "compress", href: "/compress", section: "convert", icon: FoldVertical },
  { id: "pdfToImage", href: "/pdf-to-image", section: "convert", icon: FileImage },
  { id: "imagesToPdf", href: "/images-to-pdf", section: "convert", icon: Images },
  { id: "extractImages", href: "/extract-images", section: "convert", icon: ImageDown },

  { id: "editPdf", href: "/edit-pdf", section: "edit", icon: PenLine },
  { id: "fillForm", href: "/fill-form", section: "edit", icon: TextCursorInput },
  { id: "sign", href: "/sign", section: "edit", icon: Signature },
  { id: "watermark", href: "/watermark", section: "edit", icon: Stamp },
  { id: "pageNumbers", href: "/page-numbers", section: "edit", icon: ListOrdered },
  { id: "headerFooter", href: "/header-footer", section: "edit", icon: PanelsTopBottom },
  { id: "bates", href: "/bates", section: "edit", icon: Hash },

  { id: "encrypt", href: "/encrypt", section: "security", icon: Lock },
  { id: "unlock", href: "/unlock", section: "security", icon: LockOpen },
  { id: "redact", href: "/redact", section: "security", icon: EyeOff },
  { id: "sanitize", href: "/sanitize", section: "security", icon: ShieldCheck },
  { id: "removeMetadata", href: "/remove-metadata", section: "security", icon: Eraser },
  { id: "editMetadata", href: "/edit-metadata", section: "security", icon: Tags },

  { id: "ocr", href: "/ocr", section: "recognize", icon: ScanText },
];

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
