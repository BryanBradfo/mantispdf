import { useEffect, useRef, useState } from "react";
import PageImage from "../common/PageImage";
import { visibleToPreviewRect, type Size } from "../../lib/editor/geometry";
import { widgetFrame } from "../../lib/forms/layout";
import { isDrawn, valueOf, type FormField, type FormState, type FormValue } from "../../lib/forms/model";
import { placementPreviewSize } from "../../lib/signPlacement";
import FieldControl from "./FieldControl";
import { useT } from "../../i18n";

/** Same preview size as the Edit PDF canvas. */
const PREVIEW_WIDTH = 1000;
const PREVIEW_MAX_HEIGHT = 900;

interface Props {
  source: Blob;
  /** 1-based page shown. */
  page: number;
  /** Visible page size in points (CropBox, /Rotate applied). */
  pageSize: Size;
  /** Fields in tab order: their widgets on this page are drawn (and tabbed through) in that order. */
  fields: readonly FormField[];
  state: FormState;
  onChange: (id: number, value: FormValue) => void;
  /**
   * Tab past the last control (1) or Shift+Tab before the first (-1): the page moves focus to
   * the next or previous page that has fields. Returns false when there is none (normal Tab).
   */
  onTabOut?: (direction: 1 | -1) => boolean;
}

/** The enabled field controls of a canvas, in DOM (tab) order. */
export function canvasControls(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-field-control]")).filter(
    (el) => !(el as HTMLInputElement).disabled,
  );
}

/** The page with an HTML control over each of its visible widgets. */
export default function FormCanvas({ source, page, pageSize, fields, state, onChange, onTabOut }: Props) {
  const t = useT("fillForm");
  const tc = useT("common");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(PREVIEW_WIDTH);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width || PREVIEW_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const preview: Size = placementPreviewSize(available, pageSize, PREVIEW_WIDTH, PREVIEW_MAX_HEIGHT);
  const [pw, ph] = preview;
  if (!(pageSize[0] > 0 && pageSize[1] > 0)) {
    return (
      <div ref={wrapRef} className="w-full">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t("noVisibleArea")}</p>
      </div>
    );
  }
  const scale = pw / pageSize[0];

  return (
    <div ref={wrapRef} className="w-full">
      <div
        role="group"
        aria-label={t("canvasLabel", { page })}
        data-testid="form-canvas"
        onKeyDown={(e) => {
          if (e.key !== "Tab" || !onTabOut) return;
          const controls = canvasControls(e.currentTarget);
          const edge = e.shiftKey ? controls[0] : controls[controls.length - 1];
          if (edge === undefined || e.target !== edge) return;
          if (onTabOut(e.shiftKey ? -1 : 1)) e.preventDefault();
        }}
        className="relative mx-auto overflow-hidden rounded-lg border border-gray-300 shadow-sm dark:border-[#333]"
        style={{ width: pw, height: ph }}
      >
        {/* Without the file's field appearances: the controls below show the values instead. */}
        <PageImage source={source} page={page} width={PREVIEW_WIDTH} alt={tc("pageN", { n: page })} className="h-full" mode="no-widgets" />
        {fields.flatMap((field) =>
          field.widgets.map((widget, i) => {
            if (widget.page !== page || !isDrawn(widget) || field.kind.kind === "button") return null;
            const box = visibleToPreviewRect(widgetFrame(widget).rect, preview, pageSize);
            return (
              <FieldControl
                key={`${field.id}-${i}`}
                field={field}
                widget={widget}
                index={i}
                value={valueOf(state, field.id)}
                onChange={(v) => onChange(field.id, v)}
                scale={scale}
                box={box}
              />
            );
          }),
        )}
      </div>
    </div>
  );
}
