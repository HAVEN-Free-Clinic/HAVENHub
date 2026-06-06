import type { AirtableWriter, MirrorTarget } from "./mirror";

export type AirtableReader = {
  listAll(baseId: string, tableId: string): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
};

/** Stub. The real reconciliation lands in the next task (Plan 2 Task 10). */
export async function reconcilePeople(
  _io: AirtableReader & AirtableWriter,
  _target: MirrorTarget
): Promise<number> {
  return 0;
}
