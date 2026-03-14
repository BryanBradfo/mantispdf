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
