export type DerivedStatus = {
  status: "IN_PROGRESS" | "COMPLETE";
  completed: boolean;
};

const COMPLETE = new Set(["passed", "completed"]);

/** Map a raw SCORM 1.2 cmi.core.lesson_status to the hub's coarse status. */
export function deriveStatus(lessonStatus: string | null | undefined): DerivedStatus {
  const norm = (lessonStatus ?? "").trim().toLowerCase();
  const completed = COMPLETE.has(norm);
  return { status: completed ? "COMPLETE" : "IN_PROGRESS", completed };
}

/** Parse cmi.core.score.raw (a string) to a rounded int, or null when absent. */
export function parseScore(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}
