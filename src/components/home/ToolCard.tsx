import { Link } from "react-router-dom";

interface ToolCardProps {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  available: boolean;
}

export default function ToolCard({ title, description, href, icon, available }: ToolCardProps) {
  const card = (
    <div
      className={`flex h-full flex-col rounded-xl border p-6 transition duration-150 ${
        available
          ? "border-gray-200 bg-white shadow-sm hover:-translate-y-0.5 hover:border-mantis-500 hover:shadow-lg dark:border-[#222] dark:bg-[#141414] dark:hover:border-mantis-500 dark:hover:shadow-[0_4px_20px_rgba(107,191,46,0.12)]"
          : "border-gray-100 bg-gray-50 opacity-60 dark:border-[#1a1a1a] dark:bg-[#141414]"
      }`}
    >
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-mantis-100 to-mantis-200 text-2xl dark:from-[#1a1a1a] dark:to-[#222] dark:border dark:border-[#2a2a2a]">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-[#e5e5e5]">{title}</h3>
      <p className="mt-1 flex-grow text-sm text-gray-500 dark:text-[#555]">{description}</p>
      {!available && (
        <span className="mt-3 inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-[#1a1a1a] dark:text-[#444]">
          Coming Soon
        </span>
      )}
    </div>
  );

  if (!available) return card;
  return <Link to={href}>{card}</Link>;
}
