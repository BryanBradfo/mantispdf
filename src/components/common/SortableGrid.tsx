import { useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type TouchEvent } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";

const EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** True when the event started on a control that must keep its click/keys. */
const fromControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-no-dnd]") !== null;

class GridMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: "onMouseDown" as const,
      handler: ({ nativeEvent }: MouseEvent) => nativeEvent.button === 0 && !fromControl(nativeEvent.target),
    },
  ];
}

class GridTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: ({ nativeEvent }: TouchEvent) => !fromControl(nativeEvent.target),
    },
  ];
}

class GridKeyboardSensor extends KeyboardSensor {
  static activators = [
    {
      eventName: "onKeyDown" as const,
      handler: (...args: Parameters<(typeof KeyboardSensor.activators)[0]["handler"]>) => {
        const event = args[0] as KeyboardEvent;
        // Only the card itself starts a keyboard drag, never a focused inner button.
        if (event.target !== event.currentTarget) return false;
        return KeyboardSensor.activators[0].handler(...args);
      },
    },
  ];
}

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function SortableCell({ id, label, reduced, children }: { id: string; label: string; reduced: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    // The cell contains its own buttons, so it must not be role="button" (nested-interactive).
    attributes: { role: "group" },
    // Animate every index change, so arrow-button moves and removals glide too.
    animateLayoutChanges: (args) => !reduced && !(args.wasDragging && args.index === args.newIndex),
    transition: reduced ? null : { duration: 200, easing: EASE },
  });
  const style: CSSProperties = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
    transition: transition ?? undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-label={label}
      className={`relative touch-manipulation rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-mantis-500 focus-visible:ring-offset-2 ${
        isDragging ? "cursor-grabbing" : "cursor-grab"
      }`}
    >
      {/* The source slot stays in the layout as a dashed drop target while the overlay flies. */}
      <div className={isDragging ? "invisible" : undefined}>{children}</div>
      {isDragging && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-mantis-300 bg-mantis-50/40 dark:border-mantis-700 dark:bg-mantis-950/20" />
      )}
    </div>
  );
}

interface SortableGridProps<T extends { id: string }> {
  items: T[];
  onReorder: (from: number, to: number) => void;
  renderItem: (item: T, index: number) => ReactNode;
  label: (item: T) => string;
  className?: string;
}

export default function SortableGrid<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  label,
  className,
}: SortableGridProps<T>) {
  const reduced = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(GridMouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(GridTouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(GridKeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = activeId === null ? -1 : items.findIndex((i) => i.id === activeId);

  const nameOf = (id: string | number) => {
    const item = items.find((i) => i.id === String(id));
    return item ? label(item) : "item";
  };
  const position = (id: string | number) => items.findIndex((i) => i.id === String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}, position ${position(active.id)} of ${items.length}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOf(active.id)} is over position ${position(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${nameOf(active.id)} at position ${position(over.id)}.` : `Dropped ${nameOf(active.id)}.`),
    onDragCancel: ({ active }) => `Cancelled. ${nameOf(active.id)} returned to position ${position(active.id)}.`,
  };

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === String(active.id));
    const to = items.findIndex((i) => i.id === String(over.id));
    if (from !== -1 && to !== -1) onReorder(from, to);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{ announcements }}
    >
      <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
        <div className={className}>
          {items.map((item, index) => (
            <SortableCell key={item.id} id={item.id} label={label(item)} reduced={reduced}>
              {renderItem(item, index)}
            </SortableCell>
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={reduced ? null : { duration: 200, easing: EASE }}>
        {activeIndex !== -1 ? (
          <div
            className="cursor-grabbing rounded-lg shadow-2xl"
            style={reduced ? undefined : { transform: "scale(1.04) rotate(-1.5deg)" }}
          >
            {renderItem(items[activeIndex], activeIndex)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
