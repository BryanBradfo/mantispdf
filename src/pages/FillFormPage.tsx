import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageStrip from "../components/editor/PageStrip";
import FieldList, { listedFields } from "../components/forms/FieldList";
import FormCanvas, { canvasControls } from "../components/forms/FormCanvas";
import { dirtyIds, initialFormState, isDrawn, resetForm, setValue, type FormField, type FormInfo, type FormState, type FormValue } from "../lib/forms/model";
import { tabOrder } from "../lib/forms/tabOrder";
import { blockingProblem, missingRequired, shownText } from "../lib/forms/values";
import { toWire } from "../lib/forms/toWire";
import { fieldPlan, firstDrawn, formFonts, notoFamily, overflowRequest, overflowsLayout, uncoveredIn } from "../lib/forms/unicode";
import { missingMessage } from "../lib/editor/unicodeText";
import { pageFonts } from "../lib/fonts/fontFaces";
import type { FontManifest } from "../lib/fonts/manifest";
import { cjkFlavourFromLanguage } from "../lib/fonts/select";
import { FormFontsContext, type FormFontsEnv } from "../components/forms/formFontsContext";
import { valueOf } from "../lib/forms/model";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";

interface Prepared {
  sizes: [number, number][];
  form: FormInfo;
}

const linkClass = "font-medium text-mantis-700 underline dark:text-mantis-400";

/** Field names listed in the required-fields dialog before "and N more". */
const LISTED_MISSING = 5;

/** Engine limit errors of `list_form`, as the page explains them. */
const TOO_LARGE = /^Invalid form settings: (options|widgets|fields|names)\b/;

/** Where to put focus once the page shows: a field's control, or the first/last control. */
type FocusRequest = { field: number } | { edge: "first" | "last" };

interface WorkspaceProps {
  input: PdfInput<Prepared>;
  busy: boolean;
  run: <R>(work: () => Promise<R>, done: (result: R) => void) => Promise<void>;
  /** Download errors, shown under the button row that caused them. */
  error: string | null;
  setError: (error: string | null) => void;
  fillForm: ReturnType<typeof usePdfWorker>["fillForm"];
  layoutText: ReturnType<typeof usePdfWorker>["layoutText"];
  onStartOver: () => void;
}

/** Wait after the last change before measuring Noto values with the engine. */
const MEASURE_DEBOUNCE_MS = 200;

function Workspace({ input, busy, run, error, setError, fillForm, layoutText, onStartOver }: WorkspaceProps) {
  const { sizes, form } = input.data;
  const ordered = useMemo(() => listedFields(tabOrder(form.fields)), [form.fields]);
  const [state, setState] = useState<FormState>(() => initialFormState(form));
  const [page, setPage] = useState(() => ordered[0]?.widgets.find(isDrawn)?.page ?? 1);
  const [flatten, setFlatten] = useState(false);
  const [missing, setMissing] = useState<FormField[] | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // The engine's flag covers signed fields and document-level signatures (/Perms UR3, DocMDP);
  // list_form never reports a signature field's value.
  const signed = form.signed;

  const pageSize = sizes[page - 1] ?? null;
  const pagesWithFields = useMemo(
    () => new Set(ordered.flatMap((f) => f.widgets.filter(isDrawn).map((w) => w.page))),
    [ordered],
  );
  const dirty = dirtyIds(state).length > 0;

  // Values the standard fonts cannot encode are drawn with Noto fonts: the font list is fetched
  // only once some value needs it.
  const cjk = useMemo(() => cjkFlavourFromLanguage(typeof navigator === "undefined" ? undefined : navigator.language), []);
  const needsNoto = useMemo(() => form.fields.some((f) => notoFamily(f, valueOf(state, f.id)) !== null), [form.fields, state]);
  const [manifest, setManifest] = useState<FontManifest | null>(null);
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
  // Whether each Noto value overflows its field, from the engine's own layout.
  const [overflow, setOverflow] = useState<ReadonlyMap<number, boolean>>(new Map());
  useEffect(() => {
    if (!manifest || !needsNoto) return;
    let live = true;
    const timer = setTimeout(() => {
      const checks = form.fields.flatMap((field) => {
        const value = valueOf(state, field.id);
        const plan = fieldPlan(field, value, manifest, cjk);
        const widget = firstDrawn(field);
        if (!plan || !widget || plan.faces.length === 0) return [];
        const request = overflowRequest(field, widget, shownText(field, value), plan);
        return [layoutText(request).then((layout) => [field.id, overflowsLayout(field, widget, request.size, layout)] as const)];
      });
      void Promise.allSettled(checks).then((results) => {
        if (!live) return;
        const map = new Map<number, boolean>();
        for (const r of results) if (r.status === "fulfilled") map.set(r.value[0], r.value[1]);
        setOverflow(map);
      });
    }, MEASURE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [manifest, needsNoto, form.fields, state, cjk, layoutText]);
  const fontsEnv = useMemo<FormFontsEnv>(
    () => ({ uncovered: (f, v) => uncoveredIn(f, v, manifest, cjk), overflow: (id) => overflow.get(id) }),
    [manifest, cjk, overflow],
  );

  // Typed values live only in memory: warn before the tab is closed or reloaded.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (id: number, value: FormValue) => setState((s) => setValue(s, id, value));

  // Focus after the page (and so its controls) has rendered.
  useEffect(() => {
    if (!focusRequest || !canvasRef.current) return;
    const controls = canvasControls(canvasRef.current);
    const target =
      "field" in focusRequest
        ? controls.find((el) => el.dataset.fieldControl === String(focusRequest.field))
        : focusRequest.edge === "first"
          ? controls[0]
          : controls[controls.length - 1];
    target?.focus();
    setFocusRequest(null);
  }, [focusRequest, page]);

  const pagesInOrder = useMemo(() => [...pagesWithFields].sort((a, b) => a - b), [pagesWithFields]);
  const tabOut = (direction: 1 | -1): boolean => {
    const next = direction === 1 ? pagesInOrder.find((p) => p > page) : [...pagesInOrder].reverse().find((p) => p < page);
    if (next === undefined) return false;
    setPage(next);
    setFocusRequest({ edge: direction === 1 ? "first" : "last" });
    return true;
  };

  const goTo = (f: FormField) => {
    const p = f.widgets.find(isDrawn)?.page;
    if (p !== undefined) setPage(p);
    setFocusRequest({ field: f.id });
  };

  const save = () => {
    setMissing(null);
    const values = toWire(state);
    const name = `${baseName(input.file)}_${flatten ? "flattened" : "filled"}.pdf`;
    void run(
      async () => {
        const fonts = needsNoto ? formFonts(form.fields, state, manifest ?? (await pageFonts.manifest()), cjk) : undefined;
        return fillForm(input.bytes, values, flatten, fonts);
      },
      (out) => downloadBlob(out, name),
    );
  };

  const download = () => {
    if (busy) return;
    // Values the engine would refuse block the download; empty required fields only warn.
    const problem = blockingProblem(ordered, state, fontsEnv.uncovered, missingMessage);
    if (problem) {
      setMissing(null);
      setError(problem);
      return;
    }
    setError(null);
    const empty = missingRequired(ordered, state);
    if (empty.length > 0) {
      setMissing(empty);
      return;
    }
    save();
  };

  const startOver = () => {
    if (dirty && !window.confirm("Discard the values you typed and start over?")) return;
    onStartOver();
  };

  return (
    <FormFontsContext.Provider value={fontsEnv}>
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
          {input.file.name} ({ordered.length} {ordered.length === 1 ? "field" : "fields"}, {sizes.length}{" "}
          {sizes.length === 1 ? "page" : "pages"})
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
            />
            Flatten (fields become part of the page, no longer editable)
          </label>
          <button type="button" onClick={download} disabled={busy} className={primaryButton}>
            {busy ? "Saving…" : "Download PDF"}
          </button>
          <button type="button" onClick={() => setState(resetForm)} disabled={!dirty} className={`${secondaryButton} disabled:opacity-50`}>
            Reset
          </button>
          <button type="button" onClick={startOver} className={secondaryButton}>
            Start over
          </button>
        </div>
      </div>

      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      {missing && (
        <div role="alertdialog" aria-labelledby="missing-required" className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-[#1f1a0a]">
          <p id="missing-required" className="text-sm text-amber-900 dark:text-amber-200">
            {missing.length} required {missing.length === 1 ? "field is" : "fields are"} empty:{" "}
            {missing
              .slice(0, LISTED_MISSING)
              .map((f) => f.label || f.name)
              .join(", ")}
            {missing.length > LISTED_MISSING && ` and ${missing.length - LISTED_MISSING} more`}. Download anyway?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={save} className={primaryButton}>
              Download anyway
            </button>
            <button
              type="button"
              onClick={() => {
                const first = missing[0];
                setMissing(null);
                goTo(first);
              }}
              className={secondaryButton}
            >
              Go to first
            </button>
            <button type="button" onClick={() => setMissing(null)} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {signed && (
        <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-[#1f1a0a] dark:text-amber-200">
          Filling this form invalidates its digital signatures and usage rights.
        </p>
      )}

      <p className="text-xs text-gray-500 dark:text-[#777]">
        Form scripts are not run: formatting, calculations and checks built into the form do not happen here, and
        calculated fields keep their value unless you change them.
        {form.xfa === "hybrid" && " This form also carries XFA data, which is removed from the downloaded file."}
      </p>

      {sizes.length > 1 && (
        <PageStrip source={input.file} pageCount={sizes.length} page={page} edited={pagesWithFields} onPage={setPage} markLabel="has fields" />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0" ref={canvasRef}>
          {pageSize && (
            <FormCanvas source={input.file} page={page} pageSize={pageSize} fields={ordered} state={state} onChange={change} onTabOut={tabOut} />
          )}
        </div>
        <aside className="max-h-[900px] overflow-y-auto pr-1">
          <FieldList fields={ordered} state={state} onChange={change} page={page} onPage={setPage} />
        </aside>
      </div>
    </div>
    </FormFontsContext.Provider>
  );
}

export default function FillFormPage() {
  const worker = usePdfWorker();
  const { pageSizes, listForm, fillForm, layoutText } = worker;
  const prepare = useCallback(
    async (bytes: Uint8Array): Promise<Prepared> => {
      const sizes = await pageSizes(bytes);
      try {
        return { sizes, form: await listForm(bytes) };
      } catch (err) {
        // The engine's size limits read as a malformed request; say what it means for the file.
        if (err instanceof Error && TOO_LARGE.test(err.message)) throw new Error("This form is too large or malformed to fill.");
        throw err;
      }
    },
    [pageSizes, listForm],
  );
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);

  const form = input?.data.form ?? null;
  const fillable = form !== null && form.xfa !== "pure" && listedFields(form.fields).length > 0;

  return (
    <ToolShell
      wide={fillable}
      title="Fill PDF Form: Type Into PDF Form Fields | MantisPDF"
      description="Fill in PDF forms in your browser: text fields, checkboxes, radio buttons and lists, then download the filled or flattened PDF. Free, private, nothing is uploaded."
      path="/fill-form"
      heading="Fill PDF form"
      intro="Type into the fields of a PDF form, then download it still editable or flattened. Everything stays on your device."
    >
      <ErrorAlert error={worker.initError ? `WASM engine failed to load: ${worker.initError}` : null} className="mt-4" />

      {!input && (
        <div className="mx-auto mt-8 max-w-2xl">
          <DropZone onFile={(f) => void pick(f)} error={error} engineReady={worker.ready} />
        </div>
      )}

      {input && form && !fillable && (
        <div className={panelClass}>
          <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">{input.file.name}</p>
          <p role="status" className="mt-3 text-sm text-gray-700 dark:text-[#bbb]">
            {form.xfa === "pure" ? (
              "This form uses XFA, which is not supported."
            ) : (
              <>
                This PDF has no fillable fields. Use{" "}
                <Link to="/edit-pdf" className={linkClass}>
                  Edit PDF
                </Link>{" "}
                to add text.
              </>
            )}
          </p>
          <button type="button" onClick={reset} className={`mt-6 ${secondaryButton}`}>
            Choose another file
          </button>
        </div>
      )}

      {input && fillable && (
        <>
          <Workspace input={input} busy={busy} run={run} error={error} setError={setError} fillForm={fillForm} layoutText={layoutText} onStartOver={reset} />
        </>
      )}
    </ToolShell>
  );
}
