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
      className={`rounded-xl border p-6 transition ${
        available
          ? "border-gray-200 bg-white shadow-sm hover:border-mantis-300 hover:shadow-md"
          : "border-gray-100 bg-gray-50 opacity-60"
      }`}
    >
      <div className="mb-3 text-3xl">{icon}</div>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-sm text-gray-500">{description}</p>
      {!available && (
        <span className="mt-3 inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500">
          Coming Soon
        </span>
      )}
    </div>
  );

  if (!available) return card;
  return <Link to={href}>{card}</Link>;
}
