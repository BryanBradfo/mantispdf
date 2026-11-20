import { paintMask, pixelDiff } from "../lib/compare/pixelDiff";
import type { PixelRequest, PixelResponse } from "../lib/compare/pixelClient";

/** Pure message handler (exported for tests): always answers, never throws. */
export function handlePixelMessage(msg: PixelRequest): PixelResponse {
  const id = typeof (msg as { id?: unknown })?.id === "number" ? msg.id : -1;
  if (msg?.type !== "diff") return { type: "failure", id, error: `Unknown message type: ${String((msg as { type?: unknown })?.type)}` };
  try {
    const d = pixelDiff(
      { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.a) },
      { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.b) },
    );
    const overlay = paintMask(d.mask, msg.rgba);
    return { type: "success", id, ratio: d.ratio, overlay: overlay.buffer };
  } catch (err) {
    return { type: "failure", id, error: String(err) };
  }
}

// Only inside a real worker: importing this module in tests must not touch `self`.
if (typeof self !== "undefined" && typeof document === "undefined") {
  self.onmessage = (e: MessageEvent<PixelRequest>) => {
    const res = handlePixelMessage(e.data);
    if (res.type === "success") (self as unknown as Worker).postMessage(res, [res.overlay]);
    else self.postMessage(res);
  };
}
