import { compareDocuments } from "../lib/compare/compare";
import type { CompareRequest, CompareResponse } from "../lib/compare/protocol";

self.onmessage = (e: MessageEvent<CompareRequest>) => {
  const msg = e.data;
  if (msg.type !== "compare") return;
  try {
    const result = compareDocuments(msg.a, msg.b, msg.limits);
    self.postMessage({ type: "success", id: msg.id, result } satisfies CompareResponse);
  } catch (err) {
    self.postMessage({ type: "failure", id: msg.id, error: String(err) } satisfies CompareResponse);
  }
};
