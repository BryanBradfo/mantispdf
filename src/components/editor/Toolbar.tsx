import {
  Circle,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";

export type Tool = "select" | "text" | "image" | "rect" | "ellipse" | "line" | "arrow" | "highlight" | "draw" | "whiteout";

export interface ToolInfo {
  tool: Tool;
  label: string;
  /** Keyboard shortcut (lowercase letter). */
  key: string;
  icon: LucideIcon;
}

export const TOOLS: readonly ToolInfo[] = [
  { tool: "select", label: "Select", key: "v", icon: MousePointer2 },
  { tool: "text", label: "Text", key: "t", icon: Type },
  { tool: "image", label: "Image", key: "i", icon: ImageIcon },
  { tool: "rect", label: "Rectangle", key: "r", icon: Square },
  { tool: "ellipse", label: "Ellipse", key: "o", icon: Circle },
  { tool: "line", label: "Line", key: "l", icon: Minus },
  { tool: "arrow", label: "Arrow", key: "a", icon: MoveUpRight },
  { tool: "highlight", label: "Highlight", key: "h", icon: Highlighter },
  { tool: "draw", label: "Draw", key: "d", icon: Pencil },
  { tool: "whiteout", label: "Whiteout", key: "w", icon: Eraser },
];

interface Props {
  tool: Tool;
  /** The Image tool opens the file picker instead (see `onPickImage`). */
  onTool: (tool: Tool) => void;
  onPickImage: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

const buttonClass =
  "flex min-w-[3.75rem] flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-mantis-500";

export default function Toolbar({ tool, onTool, onPickImage, canUndo, canRedo, onUndo, onRedo }: Props) {
  return (
    <div
      role="toolbar"
      aria-label="Editing tools"
      className="flex flex-wrap items-center gap-1 rounded-xl border border-gray-200 bg-white p-1.5 dark:border-[#333] dark:bg-[#111]"
    >
      {TOOLS.map(({ tool: t, label, key, icon: Icon }) => {
        const active = tool === t;
        return (
          <button
            key={t}
            type="button"
            aria-label={`${label} (${key.toUpperCase()})`}
            aria-pressed={active}
            title={`${label} (${key.toUpperCase()})`}
            onClick={() => (t === "image" ? onPickImage() : onTool(t))}
            className={`${buttonClass} ${
              active
                ? "bg-mantis-600 text-white"
                : "text-gray-700 hover:bg-gray-100 dark:text-[#bbb] dark:hover:bg-[#1f1f1f]"
            }`}
          >
            <Icon aria-hidden="true" className="h-5 w-5" />
            {label}
          </button>
        );
      })}
      <span aria-hidden="true" className="mx-1 h-8 w-px bg-gray-200 dark:bg-[#333]" />
      <button
        type="button"
        aria-label="Undo (Ctrl+Z)"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={onUndo}
        className={`${buttonClass} text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-[#bbb] dark:hover:bg-[#1f1f1f]`}
      >
        <Undo2 aria-hidden="true" className="h-5 w-5" />
        Undo
      </button>
      <button
        type="button"
        aria-label="Redo (Ctrl+Shift+Z)"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={onRedo}
        className={`${buttonClass} text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-[#bbb] dark:hover:bg-[#1f1f1f]`}
      >
        <Redo2 aria-hidden="true" className="h-5 w-5" />
        Redo
      </button>
    </div>
  );
}
