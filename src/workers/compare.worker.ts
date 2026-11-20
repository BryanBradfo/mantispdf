import { compareDocuments } from "../lib/compare/compare";
import type { CompareRequest, CompareResponse } from "../lib/compare/protocol";

/** Pure message handler (exported for tests): always answers, never leaves a request hanging. */
export function handleCompareMessage(msg: CompareRequest): CompareResponse {
  const id = typeof (msg as { id?: unknown })?.id === "number" ? msg.id : -1;
  if (msg?.type !== "compare") {
    return { type: "failure", id, error: `Unknown message type: ${String((msg as { type?: unknown })?.type)}` };
  }
  try {
    return { type: "success", id, result: compareDocuments(msg.a, msg.b, msg.limits) };
  } catch (err) {
    return { type: "failure", id, error: String(err) };
  }
}

// Only inside a real worker: importing this module in tests must not touch `self`.
if (typeof self !== "undefined" && typeof document === "undefined") {
  self.onmessage = (e: MessageEvent<CompareRequest>) => {
    self.postMessage(handleCompareMessage(e.data));
  };
}
