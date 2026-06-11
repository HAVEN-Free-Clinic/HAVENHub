"use client";
import { useLayoutEffect, useRef } from "react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
import { parseScore } from "@/modules/learning/engine/status";
import type { CmiSnapshot } from "@/modules/learning/services/enrollment";

type Props = {
  courseId: string;
  entryHref: string;
  initialCmi: CmiSnapshot;
};

/**
 * Hosts a SCORM 1.2 runtime as window.API and renders the package in an iframe.
 * The package (served same-origin from /learning/play/...) walks up to window.parent
 * to find API. On every commit/finish we read the CMI and persist it server-side.
 *
 * window.API is installed via useLayoutEffect so it is guaranteed to be present
 * before the browser paints and the iframe begins loading its content.
 */
export function ScormPlayer({ courseId, entryHref, initialCmi }: Props) {
  const apiRef = useRef<InstanceType<typeof Scorm12API> | null>(null);

  // Install the API AND wire commit/finish persistence in one layout effect, so
  // window.API and its listeners are both present synchronously after DOM commit
  // (before paint) — i.e. before the iframe loads and the package first accesses
  // the API or fires any (auto)commit. Splitting these across effects would leave
  // a paint-frame window where an early commit could be dropped.
  useLayoutEffect(() => {
    const api = new Scorm12API({ autocommit: true, autocommitSeconds: 30, logLevel: 4 });

    // Seed saved progress so the package can resume.
    if (initialCmi.lessonStatus) api.cmi.core.lesson_status = initialCmi.lessonStatus;
    if (initialCmi.lessonLocation) api.cmi.core.lesson_location = initialCmi.lessonLocation;
    if (initialCmi.scoreRaw != null) api.cmi.core.score.raw = String(initialCmi.scoreRaw);
    if (initialCmi.suspendData) api.cmi.suspend_data = initialCmi.suspendData;

    const snapshot = (): CmiSnapshot => ({
      lessonStatus: api.cmi.core.lesson_status || null,
      // parseScore rounds the SCORM string score to an int (the DB column is Int);
      // a fractional score like "83.5" would otherwise be rejected on write.
      scoreRaw: parseScore(api.cmi.core.score.raw),
      suspendData: api.cmi.suspend_data || null,
      lessonLocation: api.cmi.core.lesson_location || null,
    });
    // Fire-and-forget; an admin previewing an unassigned course is not allowed to
    // persist, so swallow the rejection rather than surface an unhandled rejection.
    const save = () => { persistCmiAction(courseId, snapshot()).catch(() => {}); };
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    (window as unknown as { API: typeof api }).API = api;
    apiRef.current = api;

    return () => {
      save();
      delete (window as unknown as { API?: typeof api }).API;
      apiRef.current = null;
    };
    // courseId/initialCmi are stable for the life of this page — they come from a
    // server-rendered snapshot and do not change during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <iframe
      title="Course content"
      src={`/learning/play/${courseId}/${entryHref}`}
      className="h-[80vh] w-full rounded-xl border border-slate-200"
    />
  );
}
