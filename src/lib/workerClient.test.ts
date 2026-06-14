import { describe, it, expect, vi } from "vitest";
import { PdfWorkerClient } from "./workerClient";
import type { ToWorker, SuccessPayload } from "./workerProtocol";

function makeClient() {
  const sent: ToWorker[] = [];
  const client = new PdfWorkerClient((msg) => sent.push(msg));
  return { sent, client };
}

const asCount = (p: SuccessPayload) => {
  if (p.kind !== "count") throw new Error("unexpected payload");
  return p.count;
};

describe("PdfWorkerClient", () => {
  it("resolves concurrent same-kind requests by id (no crossing, no hang)", async () => {
    const { sent, client } = makeClient();

    const p1 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);
    const p2 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);

    const id1 = (sent[0] as { id: number }).id;
    const id2 = (sent[1] as { id: number }).id;
    expect(id1).not.toBe(id2);
    expect(client.pendingCount).toBe(2);

    // Respond out of order: id2 first, then id1.
    client.handleMessage({ type: "success", id: id2, payload: { kind: "count", count: 22 } });
    client.handleMessage({ type: "success", id: id1, payload: { kind: "count", count: 11 } });

    // Each promise gets ITS OWN result — the bug being fixed crossed/hung these.
    await expect(p1).resolves.toBe(11);
    await expect(p2).resolves.toBe(22);
    expect(client.pendingCount).toBe(0);
  });

  it("a failure rejects only its own request", async () => {
    const { sent, client } = makeClient();
    const p1 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);
    const p2 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);
    const id1 = (sent[0] as { id: number }).id;
    const id2 = (sent[1] as { id: number }).id;

    client.handleMessage({ type: "failure", id: id1, error: "boom" });
    await expect(p1).rejects.toThrow("boom");

    client.handleMessage({ type: "success", id: id2, payload: { kind: "count", count: 5 } });
    await expect(p2).resolves.toBe(5);
  });

  it("handleError rejects all pending requests (worker crash)", async () => {
    const { client } = makeClient();
    const p1 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);
    const p2 = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);

    client.handleError(new Error("worker crashed"));

    await expect(p1).rejects.toThrow("worker crashed");
    await expect(p2).rejects.toThrow("worker crashed");
    expect(client.pendingCount).toBe(0);
  });

  it("routes progress to the matching request only", () => {
    const { sent, client } = makeClient();
    const onProgress = vi.fn();
    client.request(
      (id) => ({ type: "split", id, pdfBytes: new ArrayBuffer(0), splitAfterPages: [] }),
      (p) => (p.kind === "split" ? p.parts : []),
      { onProgress },
    );
    const id = (sent[0] as { id: number }).id;

    client.handleMessage({ type: "progress", id, progress: 0.5, message: "halfway" });
    expect(onProgress).toHaveBeenCalledWith(0.5, "halfway");

    // Progress for an unknown id is ignored (no throw).
    client.handleMessage({ type: "progress", id: 9999, progress: 1, message: "stray" });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("rejects the request if posting throws", async () => {
    const client = new PdfWorkerClient(() => {
      throw new Error("post failed");
    });
    const p = client.request((id) => ({ type: "count-pages", id, pdfBytes: new Uint8Array() }), asCount);
    await expect(p).rejects.toThrow("post failed");
    expect(client.pendingCount).toBe(0);
  });
});
