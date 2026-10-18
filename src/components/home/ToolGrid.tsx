import ToolCard from "./ToolCard";

const tools = [
  {
    title: "Split PDF",
    description: "Divide a PDF into multiple files at chosen page boundaries.",
    href: "/split",
    icon: "✂️",
    available: true,
  },
  {
    title: "Merge PDF",
    description: "Combine multiple PDFs into a single document.",
    href: "/merge",
    icon: "📎",
    available: true,
  },
  {
    title: "Compress PDF",
    description: "Reduce file size while preserving quality.",
    href: "/compress",
    icon: "📦",
    available: true,
  },
  {
    title: "Rotate Pages",
    description: "Rotate individual pages or entire documents.",
    href: "/rotate",
    icon: "🔄",
    available: true,
  },
  {
    title: "Organize PDF",
    description: "Reorder, rotate, duplicate and delete pages, even across several PDFs.",
    href: "/organize",
    icon: "🗂️",
    available: true,
  },
  {
    title: "Remove Pages",
    description: "Delete the pages you do not need.",
    href: "/remove-pages",
    icon: "🗑️",
    available: true,
  },
  {
    title: "Extract Pages",
    description: "Pull pages into a new PDF, or one file per page.",
    href: "/extract-pages",
    icon: "📤",
    available: true,
  },
  {
    title: "PDF to Images",
    description: "Export each PDF page as a PNG or JPEG image.",
    href: "/pdf-to-image",
    icon: "🖼️",
    available: true,
  },
  {
    title: "Watermark PDF",
    description: "Stamp text on every page: confidential, draft, or any label.",
    href: "/watermark",
    icon: "🔏",
    available: true,
  },
  {
    title: "Encrypt PDF",
    description: "Password-protect your PDF so only authorized readers can open it.",
    href: "/encrypt",
    icon: "🔒",
    available: true,
  },
  {
    title: "Sanitize PDF",
    description: "Strip hidden data: metadata, scripts, attachments and form data.",
    href: "/sanitize",
    icon: "🧼",
    available: true,
  },
  {
    title: "Remove Metadata",
    description: "Clear the title, author, subject and keywords.",
    href: "/remove-metadata",
    icon: "🏷️",
    available: true,
  },
  {
    title: "Edit Metadata",
    description: "Change the title, author, subject and keywords.",
    href: "/edit-metadata",
    icon: "✍️",
    available: true,
  },
  {
    title: "Unlock PDF",
    description: "Remove the password and restrictions from a PDF you can open.",
    href: "/unlock",
    icon: "🔓",
    available: true,
  },
  {
    title: "Page Numbers",
    description: "Number the pages in any corner, with your own format and font.",
    href: "/page-numbers",
    icon: "🔢",
    available: true,
  },
  {
    title: "Header & Footer",
    description: "Add text, dates and file names at the top and bottom of every page.",
    href: "/header-footer",
    icon: "📑",
    available: true,
  },
  {
    title: "Bates Numbering",
    description: "Stamp a running identifier on every page, continuing across files.",
    href: "/bates",
    icon: "⚖️",
    available: true,
  },
  {
    title: "Sign PDF",
    description: "Draw, type or upload your signature and place it on any page.",
    href: "/sign",
    icon: "🖋️",
    available: true,
  },
  {
    title: "Crop PDF",
    description: "Trim page margins by hand or detect them automatically.",
    href: "/crop",
    icon: "📐",
    available: true,
  },
  {
    title: "Resize Pages",
    description: "Change the page size to A4, Letter or a custom size.",
    href: "/resize",
    icon: "📏",
    available: true,
  },
  {
    title: "N-up Pages",
    description: "Put 2, 4, 6, 8, 9 or 16 pages on each sheet.",
    href: "/n-up",
    icon: "🔳",
    available: true,
  },
  {
    title: "Edit PDF",
    description: "Add text, images, shapes and drawings to any page.",
    href: "/edit-pdf",
    icon: "✏️",
    available: true,
  },
  {
    title: "Fill PDF form",
    description: "Fill in form fields, then download editable or flattened.",
    href: "/fill-form",
    icon: "📝",
    available: true,
  },
  {
    title: "Redact PDF",
    description: "Permanently remove sensitive text and images.",
    href: "/redact",
    icon: "⬛",
    available: true,
  },
  {
    title: "Images to PDF",
    description: "Turn JPG, PNG or WebP images into a PDF, one per page.",
    href: "/images-to-pdf",
    icon: "📷",
    available: true,
  },
  {
    title: "Extract Images",
    description: "Save the images embedded in a PDF as JPEG or PNG files.",
    href: "/extract-images",
    icon: "🧲",
    available: true,
  },
];

export default function ToolGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tools.map((tool) => (
        <ToolCard key={tool.title} {...tool} />
      ))}
    </div>
  );
}
