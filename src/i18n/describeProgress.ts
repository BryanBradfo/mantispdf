import type { ProgressStep } from "../lib/workerProtocol";
import type { NsT } from "./nsT";

export type { ProgressStep };

export function describeProgress(s: ProgressStep | null, t: NsT<"common">): string {
  if (!s) return "";
  switch (s.step) {
    case "starting":
      return t("progressStarting");
    case "splitting":
      return t("progressSplitting", { parts: s.parts });
    case "extracting":
      return t("progressExtracting", { part: s.part, of: s.of });
    case "preparing":
      return t("progressPreparing");
    case "merging":
      return t("progressMerging", { count: s.count });
    case "done":
      return t("progressDone");
  }
}
