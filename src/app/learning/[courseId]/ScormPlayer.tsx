"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
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

  // Install API synchronously after DOM commit but before paint, so the iframe
  // finds window.API on its very first access.
  useLayoutEffect(() => {
    const api = new Scorm12API({ autocommit: true, autocommitSeconds: 30, logLevel: 4 });

    // Seed saved progress so the package can resume.
    if (initialCmi.lessonStatus) api.cmi.core.lesson_status = initialCmi.lessonStatus;
    if (initialCmi.lessonLocation) api.cmi.core.lesson_location = initialCmi.lessonLocation;
    if (initialCmi.scoreRaw != null) api.cmi.core.score.raw = String(initialCmi.scoreRaw);
    if (initialCmi.suspendData) api.cmi.suspend_data = initialCmi.suspendData;

    (window as unknown as { API: typeof api }).API = api;
    apiRef.current = api;

    return () => {
      delete (window as unknown as { API?: typeof api }).API;
      apiRef.current = null;
    };
    // initialCmi is stable for the life of this page — values come from a
    // server-rendered snapshot and do not change during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up commit/finish persistence in a separate effect so the save
  // callbacks are registered after the API is installed.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const snapshot = (): CmiSnapshot => ({
      lessonStatus: api.cmi.core.lesson_status || null,
      scoreRaw: api.cmi.core.score.raw === "" ? null : Number(api.cmi.core.score.raw),
      suspendData: api.cmi.suspend_data || null,
      lessonLocation: api.cmi.core.lesson_location || null,
    });
    const save = () => { void persistCmiAction(courseId, snapshot()); };
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    return () => {
      save();
    };
    // courseId is stable for the life of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <iframe
      title="Course content"
      src={`/learning/play/${courseId}/${entryHref}`}
      className="h-[80vh] w-full rounded border border-slate-200"
    />
  );
}
