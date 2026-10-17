import { useEffect, useRef, useState } from "react";
// Self-hosted script fonts (OFL), latin 400 only. Imported here so they load with the Sign route
// chunk and no request ever leaves the app origin.
import "@fontsource/caveat/latin-400.css";
import "@fontsource/dancing-script/latin-400.css";
import "@fontsource/homemade-apple/latin-400.css";
import { fitTypedFontSize, removeWhiteBackground, trimTransparent, type RgbaImage } from "../../lib/signPlacement";
import { inputClass, secondaryButton } from "../../pages/ToolShell";

/** A trimmed RGBA signature plus a data URL of it for on-screen previews. */
export interface Signature extends RgbaImage {
  url: string;
}

type Mode = "draw" | "type" | "upload";

const MODES: { id: Mode; label: string }[] = [
  { id: "draw", label: "Draw" },
  { id: "type", label: "Type" },
  { id: "upload", label: "Upload" },
];

/** Script fonts, self-hosted via @fontsource (imported above). */
export const SIGNATURE_FONTS = ["Caveat", "Dancing Script", "Homemade Apple"] as const;
type SignatureFont = (typeof SIGNATURE_FONTS)[number];

const INK = "#1f2a44";
const PAD_W = 560;
const PAD_H = 180;
/** Longest side of an uploaded image after downscaling. */
const MAX_UPLOAD_SIDE = 1600;
/** Widest canvas a typed signature is rendered on. */
const MAX_TYPED_WIDTH = 4000;

/**
 * Trim a canvas to its opaque pixels and package it as a Signature (null when empty).
 * `dropWhite` first makes near-white pixels transparent (paper behind an uploaded signature).
 */
function canvasToSignature(canvas: HTMLCanvasElement, dropWhite = false): Signature | null {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = dropWhite ? removeWhiteBackground(data.data) : data.data;
  const trimmed = trimTransparent(pixels, canvas.width, canvas.height);
  if (!trimmed) return null;
  const out = document.createElement("canvas");
  out.width = trimmed.width;
  out.height = trimmed.height;
  out.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(trimmed.pixels), trimmed.width, trimmed.height), 0, 0);
  return { ...trimmed, url: out.toDataURL("image/png") };
}

interface Props {
  onChange: (signature: Signature | null) => void;
}

export default function SignaturePad({ onChange }: Props) {
  const [mode, setMode] = useState<Mode>("draw");

  const choose = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    onChange(null);
  };

  return (
    <div>
      <div role="tablist" aria-label="Signature source" className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-[#333]">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => choose(m.id)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${
              mode === m.id
                ? "bg-mantis-600 text-white"
                : "text-gray-700 hover:bg-gray-100 dark:text-[#aaa] dark:hover:bg-[#1a1a1a]"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="mt-3" role="tabpanel">
        {mode === "draw" && <DrawPad onChange={onChange} />}
        {mode === "type" && <TypePad onChange={onChange} />}
        {mode === "upload" && <UploadPad onChange={onChange} />}
      </div>
    </div>
  );
}

function DrawPad({ onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const points = useRef<{ x: number; y: number }[]>([]);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = PAD_W * dpr;
    canvas.height = PAD_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = pos(e);
    points.current = [p];
    // A dot, so a tap leaves a mark.
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pts = points.current;
    pts.push(pos(e));
    const n = pts.length;
    if (n < 3) return;
    // Smooth: quadratic curve through the midpoints, the sampled point as control.
    const [a, b, c] = [pts[n - 3], pts[n - 2], pts[n - 1]];
    ctx.beginPath();
    // The first curve starts at the first point itself, so the stroke has no gap after the dot.
    if (n === 3) ctx.moveTo(a.x, a.y);
    else ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
    ctx.stroke();
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const pts = points.current;
    if (ctx && pts.length >= 2) {
      const [b, c] = [pts[pts.length - 2], pts[pts.length - 1]];
      ctx.beginPath();
      // With only two points no curve was drawn yet: join them from the first point.
      if (pts.length === 2) ctx.moveTo(b.x, b.y);
      else ctx.moveTo((b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    points.current = [];
    if (canvas) {
      const sig = canvasToSignature(canvas);
      setEmpty(sig === null);
      onChange(sig);
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, PAD_W, PAD_H);
    setEmpty(true);
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        aria-label="Signature drawing area"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="aspect-[56/18] w-full max-w-[560px] cursor-crosshair touch-none rounded-lg border border-dashed border-gray-400 bg-white dark:border-[#444]"
      />
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={clear} disabled={empty} className={`${secondaryButton} disabled:opacity-50`}>
          Clear
        </button>
        <span className="text-xs text-gray-500 dark:text-[#777]">Sign with your mouse, finger or stylus.</span>
      </div>
    </div>
  );
}

async function renderTyped(name: string, font: SignatureFont): Promise<Signature | null> {
  const base = 96;
  if (typeof document.fonts?.load === "function") {
    try {
      await document.fonts.load(`${base}px "${font}"`, name);
    } catch {
      // Blocked: the canvas falls back to a default cursive font.
    }
  }
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  if (!measure) return null;
  measure.font = `${base}px "${font}", cursive`;
  // A very long name is drawn smaller instead of being clipped at the canvas edge.
  const size = fitTypedFontSize(measure.measureText(name).width, base, MAX_TYPED_WIDTH);
  const spec = `${size}px "${font}", cursive`;
  measure.font = spec;
  canvas.width = Math.min(Math.ceil(measure.measureText(name).width) + size, MAX_TYPED_WIDTH);
  canvas.height = Math.ceil(size * 2);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = spec;
  ctx.fillStyle = INK;
  ctx.textBaseline = "middle";
  ctx.fillText(name, size / 2, canvas.height / 2);
  return canvasToSignature(canvas);
}

function TypePad({ onChange }: Props) {
  const [name, setName] = useState("");
  const [font, setFont] = useState<SignatureFont>(SIGNATURE_FONTS[0]);

  useEffect(() => {
    const text = name.trim();
    if (!text) {
      onChange(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void renderTyped(text, font).then((sig) => { if (live) onChange(sig); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [name, font, onChange]);

  return (
    <div className="space-y-3">
      <label className="block text-sm text-gray-700 dark:text-[#aaa]">
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={inputClass} placeholder="Jane Doe" />
      </label>
      <fieldset>
        <legend className="text-sm text-gray-700 dark:text-[#aaa]">Style</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          {SIGNATURE_FONTS.map((f) => (
            <label
              key={f}
              className={`flex cursor-pointer items-center justify-center rounded-lg border bg-white px-3 py-2 text-2xl text-[#1f2a44] dark:bg-[#f5f5f5] ${
                font === f ? "border-mantis-500 ring-2 ring-mantis-500" : "border-gray-300 dark:border-[#333]"
              }`}
            >
              <input type="radio" name="signature-font" value={f} checked={font === f} onChange={() => setFont(f)} className="sr-only" />
              <span style={{ fontFamily: `"${f}", cursive` }} aria-label={f}>{name.trim() || "Signature"}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

async function loadImage(file: File, dropWhite: boolean): Promise<Signature | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_UPLOAD_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasToSignature(canvas, dropWhite);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function UploadPad({ onChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dropWhite, setDropWhite] = useState(true);
  // Bumped by every new load and on unmount (switching mode unmounts this pad), so a slow decode
  // never reports a signature the user has moved away from.
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  const load = async (f: File | null, white: boolean) => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    setError(null);
    setPreview(null);
    onChange(null);
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) {
      setError("Choose a PNG or JPG image.");
      return;
    }
    try {
      const sig = await loadImage(f, white);
      if (!current()) return;
      if (!sig) {
        setError(white ? "Nothing is left once the white background is removed." : "This image is fully transparent.");
        return;
      }
      setPreview(sig.url);
      onChange(sig);
    } catch {
      if (current()) setError("Could not read this image.");
    }
  };

  const pick = (f: File | undefined) => {
    setFile(f ?? null);
    void load(f ?? null, dropWhite);
  };

  const toggleWhite = (on: boolean) => {
    setDropWhite(on);
    if (file) void load(file, on);
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm text-gray-700 dark:text-[#aaa]">
        Signature image (PNG or JPG)
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => pick(e.target.files?.[0])}
          className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-mantis-600 file:px-3 file:py-2 file:text-white dark:text-[#aaa]"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#aaa]">
        <input
          type="checkbox"
          checked={dropWhite}
          onChange={(e) => toggleWhite(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-mantis-600 focus:ring-mantis-500"
        />
        Remove white background
      </label>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {preview && <img src={preview} alt="Uploaded signature" className="max-h-24 rounded border border-gray-200 bg-white p-2 dark:border-[#333]" />}
    </div>
  );
}
