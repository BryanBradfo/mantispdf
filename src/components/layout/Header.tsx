import { Link } from "react-router-dom";

export default function Header() {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-bold text-mantis-700">
          <svg className="h-8 w-8" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="4" fill="currentColor" />
            <text
              x="16"
              y="22"
              textAnchor="middle"
              fontSize="18"
              fontFamily="Arial,sans-serif"
              fontWeight="bold"
              fill="white"
            >
              M
            </text>
          </svg>
          <span className="text-xl">MantisPDF</span>
        </Link>
        <span className="text-sm text-gray-500">100% client-side — your files never leave your browser</span>
      </div>
    </header>
  );
}
