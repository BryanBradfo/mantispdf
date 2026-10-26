import ToolCard from "./ToolCard";
import { useT } from "../../i18n";

/** Tool ids name the `home` keys `<id>.title` and `<id>.desc`. */
type ToolId = "split" | "merge" | "compress" | "rotate" | "organize" | "removePages" | "extractPages" | "pdfToImage" | "watermark" | "encrypt" | "sanitize" | "removeMetadata" | "editMetadata" | "unlock" | "pageNumbers" | "headerFooter" | "bates" | "sign" | "crop" | "resize" | "nUp" | "editPdf" | "fillForm" | "redact" | "ocr" | "imagesToPdf" | "extractImages";

const tools: readonly { id: ToolId; href: string; icon: string; available: boolean }[] = [
  { id: "split", href: "/split", icon: "✂️", available: true },
  { id: "merge", href: "/merge", icon: "📎", available: true },
  { id: "compress", href: "/compress", icon: "📦", available: true },
  { id: "rotate", href: "/rotate", icon: "🔄", available: true },
  { id: "organize", href: "/organize", icon: "🗂️", available: true },
  { id: "removePages", href: "/remove-pages", icon: "🗑️", available: true },
  { id: "extractPages", href: "/extract-pages", icon: "📤", available: true },
  { id: "pdfToImage", href: "/pdf-to-image", icon: "🖼️", available: true },
  { id: "watermark", href: "/watermark", icon: "🔏", available: true },
  { id: "encrypt", href: "/encrypt", icon: "🔒", available: true },
  { id: "sanitize", href: "/sanitize", icon: "🧼", available: true },
  { id: "removeMetadata", href: "/remove-metadata", icon: "🏷️", available: true },
  { id: "editMetadata", href: "/edit-metadata", icon: "✍️", available: true },
  { id: "unlock", href: "/unlock", icon: "🔓", available: true },
  { id: "pageNumbers", href: "/page-numbers", icon: "🔢", available: true },
  { id: "headerFooter", href: "/header-footer", icon: "📑", available: true },
  { id: "bates", href: "/bates", icon: "⚖️", available: true },
  { id: "sign", href: "/sign", icon: "🖋️", available: true },
  { id: "crop", href: "/crop", icon: "📐", available: true },
  { id: "resize", href: "/resize", icon: "📏", available: true },
  { id: "nUp", href: "/n-up", icon: "🔳", available: true },
  { id: "editPdf", href: "/edit-pdf", icon: "✏️", available: true },
  { id: "fillForm", href: "/fill-form", icon: "📝", available: true },
  { id: "redact", href: "/redact", icon: "⬛", available: true },
  { id: "ocr", href: "/ocr", icon: "🔍", available: true },
  { id: "imagesToPdf", href: "/images-to-pdf", icon: "📷", available: true },
  { id: "extractImages", href: "/extract-images", icon: "🧲", available: true },
];

export default function ToolGrid() {
  const t = useT("home");
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-4">
      {tools.map(({ id, ...tool }) => (
        <ToolCard key={id} title={t(`${id}.title`)} description={t(`${id}.desc`)} {...tool} />
      ))}
    </div>
  );
}
