"use client";
import { useState } from "react";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type SortableHandleProps = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  isDragging: boolean;
};

function SortableRow<T extends { id: string }>({
  item, renderItem,
}: { item: T; renderItem: (item: T, handle: SortableHandleProps) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.85 : 1 };
  return (
    <div ref={setNodeRef} style={style}>
      {renderItem(item, { attributes: attributes as unknown as Record<string, unknown>, listeners, isDragging })}
    </div>
  );
}

export function SortableList<T extends { id: string }>({
  items, onReorder, disabled = false, renderItem,
}: {
  items: T[];
  onReorder: (orderedIds: string[]) => void | boolean | Promise<void | boolean>;
  disabled?: boolean;
  renderItem: (item: T, handle: SortableHandleProps) => React.ReactNode;
}) {
  const [optimisticIds, setOptimisticIds] = useState<string[] | null>(null);

  const itemMap = new Map(items.map((i) => [i.id, i]));
  const orderedItems: T[] = optimisticIds === null
    ? items
    : [
        ...optimisticIds.flatMap((id) => { const it = itemMap.get(id); return it ? [it] : []; }),
        ...items.filter((i) => !optimisticIds.includes(i.id)),
      ];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (disabled) {
    return <>{orderedItems.map((it) => renderItem(it, { attributes: {}, listeners: undefined, isDragging: false }))}</>;
  }

  async function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedItems.findIndex((i) => i.id === active.id);
    const newIndex = orderedItems.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const newOrder = arrayMove(orderedItems, oldIndex, newIndex).map((i) => i.id);
    setOptimisticIds(newOrder);
    const res = await onReorder(newOrder);
    if (res === false) {
      setOptimisticIds(null);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={orderedItems.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {orderedItems.map((it) => <SortableRow key={it.id} item={it} renderItem={renderItem} />)}
      </SortableContext>
    </DndContext>
  );
}
