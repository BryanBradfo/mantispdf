import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePdfWorker } from "../hooks/usePdfWorker";
import { downloadBlob } from "../lib/fileHelpers";
import DropZone from "../components/common/DropZone";
import ErrorAlert from "../components/common/ErrorAlert";
import PageStrip from "../components/editor/PageStrip";
import FieldList, { listedFields } from "../components/forms/FieldList";
import FormCanvas from "../components/forms/FormCanvas";
import { unsupportedMessage } from "../lib/editor/afm";
import { dirtyIds, initialFormState, isDrawn, resetForm, setValue, valueOf, type FormInfo, type FormState, type FormValue } from "../lib/forms/model";
import { tabOrder } from "../lib/forms/tabOrder";
import { unsupportedIn } from "../lib/forms/values";
import { toWire } from "../lib/forms/toWire";
import ToolShell, { panelClass, primaryButton, secondaryButton } from "./ToolShell";
import { baseName, usePdfInput, type PdfInput } from "./usePdfInput";

interface Prepared {
  sizes: [number, number][];
  form: FormInfo;
}

const linkClass = "font-medium text-mantis-700 underline dark:text-mantis-400";

interface WorkspaceProps {
  input: PdfInput<Prepared>;
  busy: boolean;
  run: <R>(work: () => Promise<R>, done: (result: R) => void) => Promise<void>;
  /** Download errors, shown under the button row that caused them. */
  error: string | null;
  setError: (error: string | null) => void;
  fillForm: ReturnType<typeof usePdfWorker>["fillForm"];
  onStartOver: () => void;
}

function Workspace({ input, busy, run, error, setError, fillForm, onStartOver }: WorkspaceProps) {
  const { sizes, form } = input.data;
  const ordered = useMemo(() => listedFields(tabOrder(form.fields)), [form.fields]);
  const [state, setState] = useState<FormState>(() => initialFormState(form));
  const [page, setPage] = useState(() => ordered[0]?.widgets.find(isDrawn)?.page ?? 1);
  const [flatten, setFlatten] = useState(false);

  const pageSize = sizes[page - 1] ?? null;
  const pagesWithFields = useMemo(
    () => new Set(ordered.flatMap((f) => f.widgets.filter(isDrawn).map((w) => w.page))),
    [ordered],
  );
  const dirty = dirtyIds(state).length > 0;

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

  const download = () => {
    if (busy) return;
    for (const f of ordered) {
      const bad = unsupportedIn(f, valueOf(state, f.id));
      if (bad !== "") {
        setError(`${unsupportedMessage(bad)} (field "${f.label || f.name}").`);
        return;
      }
    }
    const values = toWire(state);
    const name = `${baseName(input.file)}_${flatten ? "flattened" : "filled"}.pdf`;
    void run(
      () => fillForm(input.bytes, values, flatten),
      (out) => downloadBlob(out, name),
    );
  };

  const startOver = () => {
    if (dirty && !window.confirm("Discard the values you typed and start over?")) return;
    onStartOver();
  };

  return (
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

      <p className="text-xs text-gray-500 dark:text-[#777]">
        Form scripts are not run: formatting, calculations and checks built into the form do not happen here, and
        calculated fields keep their value unless you change them.
        {form.xfa === "hybrid" && " This form also carries XFA data, which is removed from the downloaded file."}
      </p>

      {sizes.length > 1 && (
        <PageStrip source={input.file} pageCount={sizes.length} page={page} edited={pagesWithFields} onPage={setPage} markLabel="has fields" />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {pageSize && <FormCanvas source={input.file} page={page} pageSize={pageSize} fields={ordered} state={state} onChange={change} />}
        </div>
        <aside className="max-h-[900px] overflow-y-auto pr-1">
          <FieldList fields={ordered} state={state} onChange={change} page={page} onPage={setPage} />
        </aside>
      </div>
    </div>
  );
}

export default function FillFormPage() {
  const worker = usePdfWorker();
  const { pageSizes, listForm, fillForm } = worker;
  const prepare = useCallback(
    async (bytes: Uint8Array): Promise<Prepared> => ({ sizes: await pageSizes(bytes), form: await listForm(bytes) }),
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
          <DropZone onFile={(f) => void pick(f)} error={error} />
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
          <Workspace input={input} busy={busy} run={run} error={error} setError={setError} fillForm={fillForm} onStartOver={reset} />
        </>
      )}
    </ToolShell>
  );
}
