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
