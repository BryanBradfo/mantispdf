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
import { useT } from "../../i18n";

export type Tool = "select" | "text" | "image" | "rect" | "ellipse" | "line" | "arrow" | "highlight" | "draw" | "whiteout";

export interface ToolInfo {
  tool: Tool;
  /** Keyboard shortcut (lowercase letter). */
  key: string;
  icon: LucideIcon;
}

export const TOOLS: readonly ToolInfo[] = [
  { tool: "select", key: "v", icon: MousePointer2 },
  { tool: "text", key: "t", icon: Type },
  { tool: "image", key: "i", icon: ImageIcon },
  { tool: "rect", key: "r", icon: Square },
  { tool: "ellipse", key: "o", icon: Circle },
  { tool: "line", key: "l", icon: Minus },
  { tool: "arrow", key: "a", icon: MoveUpRight },
  { tool: "highlight", key: "h", icon: Highlighter },
  { tool: "draw", key: "d", icon: Pencil },
  { tool: "whiteout", key: "w", icon: Eraser },
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
  const t = useT("editPdf");
  const tc = useT("common");
  return (
    <div
      role="toolbar"
      aria-label={t("toolbar")}
      className="flex flex-wrap items-center gap-1 rounded-xl border border-gray-200 bg-white p-1.5 dark:border-[#333] dark:bg-[#111]"
    >
      {TOOLS.map(({ tool: id, key, icon: Icon }) => {
        const active = tool === id;
        const label = t(`tool.${id}`);
        return (
          <button
            key={id}
            type="button"
            aria-label={t("toolWithKey", { label, key: key.toUpperCase() })}
            aria-pressed={active}
            title={t("toolWithKey", { label, key: key.toUpperCase() })}
            onClick={() => (id === "image" ? onPickImage() : onTool(id))}
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
        aria-label={t("undoLabel")}
        title={t("undoLabel")}
        disabled={!canUndo}
        onClick={onUndo}
        className={`${buttonClass} text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-[#bbb] dark:hover:bg-[#1f1f1f]`}
      >
        <Undo2 aria-hidden="true" className="h-5 w-5" />
        {tc("undo")}
      </button>
      <button
        type="button"
        aria-label={t("redoLabel")}
        title={t("redoLabel")}
        disabled={!canRedo}
        onClick={onRedo}
        className={`${buttonClass} text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-[#bbb] dark:hover:bg-[#1f1f1f]`}
      >
        <Redo2 aria-hidden="true" className="h-5 w-5" />
        {tc("redo")}
      </button>
    </div>
  );
}
