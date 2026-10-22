import type { EditJobSpec } from "../editor/toJob";
import type { FontLoader } from "./loader";

/** The font files the job's embedded-font text boxes name, once each, in first-use order. */
export function jobFontFiles(job: EditJobSpec): string[] {
  const files: string[] = [];
  for (const item of job.items) {
    if (item.kind !== "text" || item.family !== "noto") continue;
    for (const file of item.faces) if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** `job` with the bytes of the fonts its text boxes name (`fonts`), fetched through `loader`. */
export async function attachJobFonts(job: EditJobSpec, loader: Pick<FontLoader, "font">): Promise<EditJobSpec> {
  const files = jobFontFiles(job);
  if (files.length === 0) return job;
  const fonts = await Promise.all(files.map(async (id) => ({ id, bytes: await loader.font(id) })));
  return { ...job, fonts };
}

/** One run of a laid-out line: drawn with `fonts[face]`, `text` in reading order, `x` and `width` in points from the box's left edge. */
export interface TextLayoutRun {
  face: number;
  rtl: boolean;
  x: number;
  width: number;
  text: string;
}

/** The engine's layout of a text box (`layout_text`): `baselineY` in points down from the box's top. */
export interface TextLayout {
  lines: { baselineY: number; runs: TextLayoutRun[] }[];
  /** Characters no font covers. */
  missing: string;
}
