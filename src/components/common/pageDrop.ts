/**
 * Drop anywhere on the page: the mounted, enabled drop zones register here. The first one in
 * document order (the one a person would reach first) receives files dropped on the page overlay;
 * when it unmounts (its file is loaded), the next one takes over (Compare's second slot). With one
 * zone a full-page overlay takes the drop; with several, each zone stays a visible target.
 */
export interface PageDropTarget {
  /** The zone's element, for document order. */
  el: HTMLElement | null;
  /** Hands dropped files to the zone (same path as a drop on the zone itself). */
  deliver: (files: File[]) => void;
}

const targets = new Set<PageDropTarget>();
const subscribers = new Set<() => void>();

function notify() {
  for (const s of subscribers) s();
}

let dragActive = false;

/** Files are being dragged over the window (set by the leader's window listeners). */
export function setPageDragActive(active: boolean) {
  if (active === dragActive) return;
  dragActive = active;
  notify();
}

export function pageDragActive(): boolean {
  return dragActive;
}

/**
 * More than one zone takes drops (Compare): no full-page overlay then, every zone lights up as a
 * target, a drop on a zone goes to it and a drop elsewhere goes to the leader.
 */
export function pageHasSeveralDropTargets(): boolean {
  return targets.size > 1;
}

export function registerPageDropTarget(target: PageDropTarget): () => void {
  targets.add(target);
  notify();
  return () => {
    targets.delete(target);
    notify();
  };
}

export function subscribePageDrop(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/** The target that receives page drops: the first in document order, or null when none is mounted. */
export function pageDropLeader(): PageDropTarget | null {
  let first: PageDropTarget | null = null;
  for (const t of targets) {
    if (!first) first = t;
    else if (t.el && first.el && t.el.compareDocumentPosition(first.el) & Node.DOCUMENT_POSITION_FOLLOWING) first = t;
  }
  return first;
}

/** True when a drag carries files (not text, links or in-page elements). */
export function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
