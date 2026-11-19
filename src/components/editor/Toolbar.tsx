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
import { focusRing } from "../../styles/ui";

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

// The buttons sit edge to edge: the focus ring is drawn inset so the next button cannot cover it,
// in paper on the ink-filled active tool.
const buttonClass = `flex min-w-[3.75rem] flex-col items-center gap-0.5 rounded-none px-2 py-1.5 text-xs font-medium transition-opacity ${focusRing} focus-visible:ring-inset focus-visible:!ring-offset-0`;
const idleClass = "text-ink-2 hover:bg-ink hover:text-paper";

export default function Toolbar({ tool, onTool, onPickImage, canUndo, canRedo, onUndo, onRedo }: Props) {
  const t = useT("editPdf");
  const tc = useT("common");
  return (
    <div
      role="toolbar"
      aria-label={t("toolbar")}
      className="flex flex-wrap items-center gap-1 border border-line bg-surface p-1"
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
              active ? "bg-ink text-paper focus-visible:!ring-paper" : idleClass
            }`}
          >
            <Icon aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
            {label}
          </button>
        );
      })}
      <span aria-hidden="true" className="mx-1 h-8 w-px bg-line" />
      <button
        type="button"
        aria-label={t("undoLabel")}
        title={t("undoLabel")}
        disabled={!canUndo}
        onClick={onUndo}
        className={`${buttonClass} ${idleClass} disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2`}
      >
        <Undo2 aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
        {tc("undo")}
      </button>
      <button
        type="button"
        aria-label={t("redoLabel")}
        title={t("redoLabel")}
        disabled={!canRedo}
        onClick={onRedo}
        className={`${buttonClass} ${idleClass} disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-2`}
      >
        <Redo2 aria-hidden="true" strokeWidth={1.5} className="h-5 w-5" />
        {tc("redo")}
      </button>
    </div>
  );
}
