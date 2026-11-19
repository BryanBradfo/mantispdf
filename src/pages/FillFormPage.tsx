import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Trans, UserError, useT } from "../i18n";
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
import { fieldPlan, firstDrawn, fontProblem, formFonts, notoFamily, overflowRequest, overflowsLayout, uncoveredIn } from "../lib/forms/unicode";
import { missingMessage } from "../lib/editor/unicodeText";
import { pageFonts } from "../lib/fonts/fontFaces";
import type { FontManifest } from "../lib/fonts/manifest";
import { cjkFlavourFromLanguage } from "../lib/fonts/select";
import { FormFontsContext, type FormFontsEnv } from "../components/forms/formFontsContext";
import { valueOf } from "../lib/forms/model";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";
import type { UiError } from "../i18n";

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
  error: UiError | null;
  setError: (error: UiError | null) => void;
  fillForm: ReturnType<typeof usePdfWorker>["fillForm"];
  layoutText: ReturnType<typeof usePdfWorker>["layoutText"];
  onStartOver: () => void;
}

/** Wait after the last change before measuring Noto values with the engine. */
const MEASURE_DEBOUNCE_MS = 200;

function Workspace({ input, busy, run, error, setError, fillForm, layoutText, onStartOver }: WorkspaceProps) {
  const t = useT("fillForm");
  const tc = useT("common");
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
  // Whether each Noto value overflows its field, from the engine's own layout. Only fields whose
  // request changed since their last measure are laid out again.
  const [overflow, setOverflow] = useState<ReadonlyMap<number, boolean>>(new Map());
  const measured = useRef(new Map<number, string>());
  useEffect(() => {
    if (!manifest || !needsNoto) return;
    let live = true;
    // Requests sent and not applied yet: forgotten if this run is superseded, so they are sent again.
    const pending: [number, string][] = [];
    const timer = setTimeout(() => {
      const checks = form.fields.flatMap((field) => {
        const value = valueOf(state, field.id);
        const plan = fieldPlan(field, value, manifest, cjk);
        const widget = firstDrawn(field);
        // List boxes never overflow (their rows scroll).
        if (!plan || !widget || plan.faces.length === 0 || field.kind.kind === "list") return [];
        const request = overflowRequest(field, widget, shownText(field, value), plan);
        const key = JSON.stringify(request);
        if (measured.current.get(field.id) === key) return [];
        measured.current.set(field.id, key);
        pending.push([field.id, key]);
        return [layoutText(request).then((layout) => [field.id, overflowsLayout(field, widget, layout)] as const)];
      });
      if (checks.length === 0) return;
      void Promise.allSettled(checks).then((results) => {
        if (!live) return;
        pending.length = 0;
        setOverflow((before) => {
          const map = new Map(before);
          for (const r of results) if (r.status === "fulfilled") map.set(r.value[0], r.value[1]);
          return map;
        });
      });
    }, MEASURE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      for (const [id, key] of pending) if (measured.current.get(id) === key) measured.current.delete(id);
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
        let fonts;
        if (needsNoto) {
          const loaded = manifest ?? (await pageFonts.manifest());
          // The click may have come before the font list loaded: check uncovered characters again.
          const problem = fontProblem(ordered, state, loaded, cjk, t, tc);
          if (problem) throw new UserError(problem);
          fonts = formFonts(form.fields, state, loaded, cjk);
        }
        return fillForm(input.bytes, values, flatten, fonts);
      },
      (out) => downloadBlob(out, name),
    );
  };

  const download = () => {
    if (busy) return;
    // Values the engine would refuse block the download; empty required fields only warn.
    const problem = blockingProblem(ordered, state, t, fontsEnv.uncovered, (bad) => missingMessage(bad, tc));
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
    if (dirty && !window.confirm(t("discardConfirm"))) return;
    onStartOver();
  };

  return (
    <FormFontsContext.Provider value={fontsEnv}>
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-800 dark:text-[#ccc]">
          {t("fileSummary", {
            name: input.file.name,
            fields: t("fields", { count: ordered.length }),
            pages: t("pages", { count: sizes.length }),
          })}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
            />
            {t("flatten")}
          </label>
          <button type="button" onClick={download} disabled={busy} className={primaryButton}>
            {busy ? tc("saving") : tc("downloadPdf")}
          </button>
          <button type="button" onClick={() => setState(resetForm)} disabled={!dirty} className={`${secondaryButton} disabled:opacity-50`}>
            {tc("reset")}
          </button>
          <button type="button" onClick={startOver} className={secondaryButton}>
            {tc("startOver")}
          </button>
        </div>
      </div>

      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      {missing && (
        <div role="alertdialog" aria-labelledby="missing-required" className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-[#1f1a0a]">
          <p id="missing-required" className="text-sm text-amber-900 dark:text-amber-200">
            {t("missing", {
              count: missing.length,
              names: missing
                .slice(0, LISTED_MISSING)
                .map((f) => f.label || f.name)
                .join(", "),
              more: missing.length > LISTED_MISSING ? t("missingMore", { count: missing.length - LISTED_MISSING }) : "",
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={save} className={primaryButton}>
              {t("downloadAnyway")}
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
              {t("goToFirst")}
            </button>
            <button type="button" onClick={() => setMissing(null)} className={secondaryButton}>
              {tc("cancel")}
            </button>
          </div>
        </div>
      )}

      {signed && (
        <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-[#1f1a0a] dark:text-amber-200">
          {t("signedWarning")}
        </p>
      )}

      <p className="text-xs text-gray-500 dark:text-[#777]">
        {t("scriptsNote")}
        {form.xfa === "hybrid" && ` ${t("xfaHybrid")}`}
      </p>

      {sizes.length > 1 && (
        <PageStrip source={input.file} pageCount={sizes.length} page={page} edited={pagesWithFields} onPage={setPage} markLabel={t("markHasFields")} />
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
  const t = useT("fillForm");
  const tc = useT("common");
  const worker = usePdfWorker();
  const { pageSizes, listForm, fillForm, layoutText, resetFonts } = worker;
  const prepare = useCallback(
    async (bytes: Uint8Array): Promise<Prepared> => {
      const sizes = await pageSizes(bytes);
      try {
        return { sizes, form: await listForm(bytes) };
      } catch (err) {
        // The engine's size limits read as a malformed request; say what it means for the file.
        if (err instanceof Error && TOO_LARGE.test(err.message)) throw new UserError(t("tooLarge"));
        throw err;
      }
    },
    [pageSizes, listForm, t],
  );
  const { input, error, setError, busy, pick, reset, run } = usePdfInput(worker, prepare);
  // Start over frees the worker's preview fonts.
  useEffect(() => {
    if (input === null) resetFonts().catch(() => undefined);
  }, [input, resetFonts]);

  const form = input?.data.form ?? null;
  const fillable = form !== null && form.xfa !== "pure" && listedFields(form.fields).length > 0;

  return (
    <ToolShell
      wide={fillable}
      title={t("seoTitle")}
      description={t("seoDescription")}
      path="/fill-form"
      heading={t("heading")}
      intro={t("intro")}
    >
      <ErrorAlert error={worker.initProblem} className="mt-4" />

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
              t("xfaPure")
            ) : (
              <Trans
                ns="fillForm"
                k="noFields"
                components={{
                  link: (c) => (
                    <Link to="/edit-pdf" className={linkClass}>
                      {c}
                    </Link>
                  ),
                }}
              />
            )}
          </p>
          <button type="button" onClick={reset} className={`mt-6 ${secondaryButton}`}>
            {tc("chooseAnother")}
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
