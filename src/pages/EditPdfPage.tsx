import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import EditorCanvas from "../components/editor/EditorCanvas";
import PageStrip from "../components/editor/PageStrip";
import PropertiesPanel from "../components/editor/PropertiesPanel";
import Toolbar, { type Tool } from "../components/editor/Toolbar";
import {
  addError,
  imageBudgetError,
  imagePayloadBytes,
  initialEditorState,
  type ImageSource,
  type Item,
  type NewItem,
  type TextItem,
} from "../lib/editor/model";
import { editorReducer } from "../lib/editor/reducer";
import { fitTextRect } from "../lib/editor/textFit";
import { buildEditJob, type TextFontSpec } from "../lib/editor/toJob";
import { missingMessage, planFonts, resolveFont } from "../lib/editor/unicodeText";
import { pageFonts } from "../lib/fonts/fontFaces";
import type { FontManifest } from "../lib/fonts/manifest";
import { cjkFlavourFromLanguage, type CjkFlavour } from "../lib/fonts/select";
import { UnicodeTextContext, type UnicodeTextEnv } from "../components/editor/unicodeTextContext";
import { jpegPassthrough, orientationToTransform, readExifOrientation } from "../lib/imageInput";
import ToolShell, { primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp";

/** Upright pixel size of a picked image (the browser applies its EXIF orientation). */
async function uprightSize(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== "undefined") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      // Fall back to <img> below (some formats only decode there).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reads a picked image once: its upright size and what each placement adds to the image budget. */
async function readImageSource(file: File): Promise<ImageSource> {
  let size: { width: number; height: number };
  try {
    size = await uprightSize(file);
  } catch {
    throw new Error(`${file.name} could not be read as an image.`);
  }
  if (size.width < 1 || size.height < 1) throw new Error(`${file.name} could not be read as an image.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Same rule as buildEditJob: a JPEG goes through as is unless its EXIF orientation is mirrored.
  const passthrough = jpegPassthrough(bytes) && !orientationToTransform(readExifOrientation(bytes)).flipX;
  return { blob: file, ...size, bytes: imagePayloadBytes(bytes.length, size.width, size.height, passthrough) };
}

/** First text box whose content the standard fonts cannot save, as a user message. */
/** How each text box is drawn: its standard font, or the Noto font files it needs (chain order). */
function textFonts(manifest: FontManifest, cjk: CjkFlavour) {
  return (item: TextItem): TextFontSpec => {
    const resolved = resolveFont(item.font, item.text);
    if (resolved.kind === "standard") return { family: "standard", font: resolved.font };
    const plan = planFonts(manifest, item.text, resolved.family, resolved.bold, cjk);
    return { family: "noto", faces: plan.faces.map((f) => f.file), fakeBold: plan.fakeBold.map((f) => f.file) };
  };
}

/** The first text box with characters no font can show, as a message. */
function textProblem(items: readonly Item[], manifest: FontManifest, cjk: CjkFlavour): string | null {
  for (const it of items) {
    if (it.kind !== "text") continue;
    const resolved = resolveFont(it.font, it.text);
    if (resolved.kind === "standard") continue;
    const { missing } = planFonts(manifest, it.text, resolved.family, resolved.bold, cjk);
    if (missing !== "") return `${missingMessage(missing)} (text box on page ${it.page}).`;
  }
  return null;
}

interface WorkspaceProps {
  input: PdfInput<[number, number][]>;
  busy: boolean;
  run: <R>(work: () => Promise<R>, done: (result: R) => void) => Promise<void>;
  editPdf: ReturnType<typeof usePdfWorker>["editPdf"];
  layoutText: ReturnType<typeof usePdfWorker>["layoutText"];
  onStartOver: () => void;
}

function Workspace({ input, busy, run, editPdf, layoutText, onStartOver }: WorkspaceProps) {
  const sizes = input.data;
  const [state, dispatch] = useReducer(editorReducer, undefined, () => initialEditorState());
  const [tool, setTool] = useState<Tool>("select");
  const [pendingImage, setPendingImage] = useState<ImageSource | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // True from a text box's creation to the commit of its first text: both are one gesture, so
  // they make a single undo step.
  const newTextGesture = useRef(false);
  const urls = useRef(new Map<Blob, string>());
  // The self-hosted font list, fetched only once some text box needs Noto (as the fonts are).
  const [manifest, setManifest] = useState<FontManifest | null>(null);
  const cjk = useMemo(() => cjkFlavourFromLanguage(typeof navigator === "undefined" ? undefined : navigator.language), []);
  const needsNoto = useMemo(() => state.items.some((it) => it.kind === "text" && resolveFont(it.font, it.text).kind === "noto"), [state.items]);
  useEffect(() => {
    if (!needsNoto || manifest) return;
    let live = true;
    pageFonts
      .manifest()
      .then((m) => live && setManifest(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [needsNoto, manifest]);
  const fit = useCallback((id: string, height: number) => dispatch({ type: "fit", id, height }), []);
  // What each text box was last fitted for (see UnicodeTextEnv.fitted): outlives its preview.
  const fitted = useRef(new Map<string, string>());
  const unicodeText = useMemo<UnicodeTextEnv>(
    () => ({ manifest, cjk, layoutText, fit, fitted: fitted.current }),
    [manifest, cjk, layoutText, fit],
  );

  const { items, page, selectedId, editingId } = state;
  const setEditingId = (id: string | null) => dispatch({ type: "editText", id });
  const pageSize = sizes[page - 1] ?? null;
  const selected = items.find((it) => it.id === selectedId && it.page === page) ?? null;
  const edited = useMemo(() => new Set(items.map((it) => it.page)), [items]);

  // One object URL per picked image, kept until the editor closes (undo can bring an image back).
  const imageUrl = useCallback((blob: Blob) => {
    let url = urls.current.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      urls.current.set(blob, url);
    }
    return url;
  }, []);
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // Guard: if a new text box stops being edited without a commit (it was removed some other
  // way), close its creation gesture so later changes are undoable again.
  useEffect(() => {
    if (newTextGesture.current && editingId === null) {
      newTextGesture.current = false;
      dispatch({ type: "endGesture" });
    }
  }, [editingId]);

  // Edits live only in memory: warn before the tab is closed or reloaded.
  const hasEdits = items.length > 0;
  useEffect(() => {
    if (!hasEdits) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasEdits]);

  const chooseTool = (next: Tool) => {
    setTool(next);
    if (next !== "image") setPendingImage(null);
  };

  /** The limit check shared by every way of adding an item; shows why it is refused. */
  const allowAdd = (item: NewItem | Item): boolean => {
    const problem = addError(items, item);
    setNotice(problem);
    return problem === null;
  };

  const onCreate = (item: NewItem): boolean => {
    if (!allowAdd(item)) return false;
    if (item.kind === "image") setPendingImage(null);
    if (item.kind === "text") {
      // Closed by onCommitText. The `add` itself puts the box in edit mode (reducer), so keys
      // typed right after the click already go to its textarea.
      newTextGesture.current = true;
      dispatch({ type: "beginGesture" });
    }
    dispatch({ type: "add", item });
    return true;
  };

  const duplicate = (id: string) => {
    const it = items.find((i) => i.id === id);
    if (it && allowAdd(it)) dispatch({ type: "duplicate", id });
  };

  const onCommitText = (id: string, text: string) => {
    const isNew = newTextGesture.current;
    newTextGesture.current = false;
    setEditingId(null);
    const it = items.find((i) => i.id === id);
    if (!it || it.kind !== "text") {
      if (isNew) dispatch({ type: "endGesture" });
      return;
    }
    // An empty text box draws nothing: a new one is undone as if never created, an existing
    // one is deleted.
    if (text.trim() === "") {
      dispatch(isNew ? { type: "cancelGesture" } : { type: "delete", id });
      return;
    }
    if (text !== it.text) {
      dispatch({ type: "update", id, props: { text, rect: fitTextRect(it.rect, text, it.font, it.size, it.lineHeight) } });
    }
    if (isNew) dispatch({ type: "endGesture" });
  };

  const pickImage = () => fileRef.current?.click();

  const onImageFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const source = await readImageSource(file);
      const problem = imageBudgetError(items, source);
      if (problem) {
        setNotice(problem);
        return;
      }
      setNotice(null);
      setPendingImage(source);
      setTool("image");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const download = () => {
    if (busy || items.length === 0) return;
    void run(
      async () => {
        // Standard fonts only: no font list, no fonts.
        if (!needsNoto) return editPdf(input.bytes, await buildEditJob(items));
        const fonts = manifest ?? (await pageFonts.manifest());
        const problem = textProblem(items, fonts, cjk);
        if (problem) throw new Error(problem);
        return editPdf(input.bytes, await buildEditJob(items, undefined, textFonts(fonts, cjk)));
      },
      (out) => downloadBlob(out, `${baseName(input.file)}_edited.pdf`),
    );
  };

  const startOver = () => {
    if (hasEdits && !window.confirm("Discard all your edits and start over?")) return;
    onStartOver();
  };

  const gestureProps = {
    onBeginGesture: () => dispatch({ type: "beginGesture" }),
    onEndGesture: () => dispatch({ type: "endGesture" }),
  };

  return (
    <UnicodeTextContext.Provider value={unicodeText}>
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
          {input.file.name} ({sizes.length} {sizes.length === 1 ? "page" : "pages"})
        </p>
        <div className="flex gap-3">
          <button type="button" onClick={download} disabled={busy || items.length === 0} className={primaryButton}>
            {busy ? "Saving…" : "Download PDF"}
          </button>
          <button type="button" onClick={startOver} className={secondaryButton}>
            Start over
          </button>
        </div>
      </div>

      <Toolbar
        tool={tool}
        onTool={chooseTool}
        onPickImage={pickImage}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
      />
      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void onImageFile(file);
        }}
      />

      {sizes.length > 1 && (
        <PageStrip source={input.file} pageCount={sizes.length} page={page} edited={edited} onPage={(n) => dispatch({ type: "setPage", page: n })} />
      )}

      {notice && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-[#1f1a0a] dark:text-amber-200">
          {notice}
        </p>
      )}
      {tool === "image" && pendingImage && (
        <p className="text-sm text-gray-700 dark:text-[#aaa]">Click or drag on the page to place the image.</p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          {pageSize && (
            <EditorCanvas
              source={input.file}
              page={page}
              pageSize={pageSize}
              items={items}
              selectedId={selectedId}
              editingId={editingId}
              tool={tool}
              pendingImage={pendingImage}
              imageUrl={imageUrl}
              dispatch={dispatch}
              onCreate={onCreate}
              onDuplicate={duplicate}
              onTool={chooseTool}
              onPickImage={pickImage}
              onEditText={setEditingId}
              onCommitText={onCommitText}
            />
          )}
        </div>
        <aside className="space-y-4">
          {selected ? (
            <PropertiesPanel
              key={selected.id}
              item={selected}
              onChange={(patch) => dispatch({ type: "update", id: selected.id, props: patch })}
              {...gestureProps}
              onEditText={() => setEditingId(selected.id)}
              onForward={() => dispatch({ type: "forward", id: selected.id })}
              onBackward={() => dispatch({ type: "backward", id: selected.id })}
              onDuplicate={() => duplicate(selected.id)}
              onDelete={() => dispatch({ type: "delete", id: selected.id })}
            />
          ) : (
            <p className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-[#333] dark:text-[#888]">
              Pick a tool, then click or drag on the page. Select an item to change its colour, size or order.
            </p>
          )}
          <p className="text-xs text-gray-500 dark:text-[#777]">
            Whiteout hides content, it does not delete it. Use{" "}
            <Link to="/redact" className="font-medium text-mantis-700 underline dark:text-mantis-400">
              Redact
            </Link>{" "}
            to remove text.
          </p>
        </aside>
      </div>
    </div>
    </UnicodeTextContext.Provider>
  );
}

export default function EditPdfPage() {
  const worker = usePdfWorker();
  const { pageSizes, editPdf, layoutText } = worker;
  const prepare = useCallback((bytes: Uint8Array) => pageSizes(bytes), [pageSizes]);
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  return (
    <ToolShell
      wide
      title="Edit PDF: Add Text, Images and Shapes | MantisPDF"
      description="Edit a PDF in your browser: add text, images, shapes, arrows, highlights, drawings and whiteout. Free, private, nothing is uploaded."
      path="/edit-pdf"
      heading="Edit PDF"
      intro="Add text, images, shapes, highlights and drawings to any page. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mx-auto mt-8 max-w-2xl">
          <DropZone onFile={(f) => void pick(f)} error={error} engineReady={worker.ready} />
        </div>
      )}

      {input && (
        <>
          <Workspace input={input} busy={busy} run={run} editPdf={editPdf} layoutText={layoutText} onStartOver={reset} />
          <ErrorAlert error={error} onDismiss={() => setError(null)} className="mt-4" />
        </>
      )}
    </ToolShell>
  );
}
