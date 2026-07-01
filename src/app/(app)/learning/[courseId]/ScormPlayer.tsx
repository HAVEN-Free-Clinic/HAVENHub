"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
import { Alert } from "@/platform/ui/alert";
import { deriveStatus, parseScore } from "@/modules/learning/engine/status";
import type { LearnerSco } from "@/modules/learning/services/enrollment";

type Props = {
  courseId: string;
  scos: LearnerSco[];
};

/** Live per-SCO status the UI renders from (kept in React state so checkmarks, the
 *  quiz score, and the completion banner update during the session, not only on reload). */
type ScoLive = { lessonStatus: string | null; scoreRaw: number | null };

/**
 * Hosts a SCORM 1.2 runtime as window.API and renders one SCO at a time in an
 * iframe, with a table of contents for multi-SCO packages.
 *
 * Live UI: eXeLearning writes cmi.core.lesson_status/score.raw via LMSSetValue
 * (content pages mark "completed" on unload; quiz idevices write a score + passed/
 * failed on submit). We listen for those writes and mirror them into React state, so
 * the TOC checkmarks, the per-page score, and the completion banner reflect progress
 * immediately rather than only after a refresh.
 *
 * SCO switching (goTo) does an in-page handoff rather than a remount/reload: we point
 * the iframe at about:blank first, so the outgoing SCO unloads and fires its writes +
 * LMSFinish against the still-current window.API (that's when a content page becomes
 * "completed"). Because only the iframe navigates -- not the parent -- the persistence
 * fetch issued from this component survives. We then install the next SCO's API.
 */
export function ScormPlayer({ courseId, scos }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [live, setLive] = useState<Record<string, ScoLive>>(() =>
    Object.fromEntries(scos.map((s) => [s.id, { lessonStatus: s.cmi.lessonStatus, scoreRaw: s.cmi.scoreRaw }]))
  );
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const apiRef = useRef<InstanceType<typeof Scorm12API> | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const switchingRef = useRef(false);
  const saveActiveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Build a fresh API for one SCO: seed saved state, mirror live writes into React
  // state, wire commit/finish persistence (tagged with this SCO's id), install as window.API.
  function installApi(sco: LearnerSco) {
    const api = new Scorm12API({ autocommit: true, autocommitSeconds: 30, logLevel: 4 });
    if (sco.cmi.lessonStatus) api.cmi.core.lesson_status = sco.cmi.lessonStatus;
    if (sco.cmi.lessonLocation) api.cmi.core.lesson_location = sco.cmi.lessonLocation;
    if (sco.cmi.scoreRaw != null) api.cmi.core.score.raw = String(sco.cmi.scoreRaw);
    if (sco.cmi.suspendData) api.cmi.suspend_data = sco.cmi.suspendData;

    const snapshot = () => ({
      lessonStatus: api.cmi.core.lesson_status || null,
      scoreRaw: parseScore(api.cmi.core.score.raw),
      suspendData: api.cmi.suspend_data || null,
      lessonLocation: api.cmi.core.lesson_location || null,
    });
    // Mirror this SCO's current status/score into React state so the UI is live.
    const sync = () =>
      setLive((prev) => ({
        ...prev,
        [sco.id]: { lessonStatus: api.cmi.core.lesson_status || null, scoreRaw: parseScore(api.cmi.core.score.raw) },
      }));
    const save = () => {
      sync();
      const p = persistCmiAction(courseId, sco.id, snapshot()).catch(() => {});
      pendingSaveRef.current = p;
      return p;
    };
    // Fire the instant eXe writes status/score (e.g. a quiz submit), before any commit.
    api.on("LMSSetValue.cmi.core.lesson_status", sync);
    api.on("LMSSetValue.cmi.core.score.raw", sync);
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    (window as unknown as { API: typeof api }).API = api;
    apiRef.current = api;
    saveActiveRef.current = save;
    return save;
  }

  // Initial mount: install the first SCO's API before paint, so the iframe (which
  // renders with the first SCO's src) finds window.API on load. Unmount: persist + remove.
  useLayoutEffect(() => {
    installApi(scos[0]);
    return () => {
      saveActiveRef.current();
      delete (window as unknown as { API?: unknown }).API;
      apiRef.current = null;
    };
    // scos is a stable server-rendered snapshot for the life of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function goTo(index: number) {
    if (index === activeIndex || switchingRef.current) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    switchingRef.current = true;
    try {
      await blankIframe(iframe); // outgoing SCO unloads -> writes "completed" + LMSFinish on current API
      await pendingSaveRef.current; // let that completion write land
      delete (window as unknown as { API?: unknown }).API;
      apiRef.current = null;
      installApi(scos[index]); // window.API now points at the next SCO
      iframe.src = `/learning/play/${courseId}/${scos[index].href}`;
      setActiveIndex(index);
    } finally {
      switchingRef.current = false;
    }
  }

  const single = scos.length <= 1;
  const allComplete = scos.length > 0 && scos.every((s) => deriveStatus(live[s.id]?.lessonStatus).completed);

  return (
    <div className="space-y-4">
      {allComplete && <Alert tone="success">You have completed this course.</Alert>}
      <div className="flex flex-col gap-4 md:flex-row">
        {!single && (
          <nav aria-label="Course pages" className="md:w-56 md:shrink-0">
            <ol className="space-y-1">
              {scos.map((s, i) => {
                const isActive = i === activeIndex;
                const st = live[s.id];
                const done = deriveStatus(st?.lessonStatus).completed;
                return (
                  <li key={s.id}>
                    {/* eslint-disable-next-line no-restricted-syntax -- course-page nav tab, state-dependent active/inactive styling */}
                    <button type="button" onClick={() => goTo(i)} aria-current={isActive ? "page" : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${isActive ? "bg-teal-50 font-medium text-teal-800" : "text-foreground-soft hover:bg-muted"}`}>
                      <span
                        aria-hidden
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                          done ? "border-teal-600 bg-teal-600 text-white" : "border-border-strong text-subtle-foreground"
                        }`}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span className="truncate">{s.title}</span>
                      {/* Only show a score once it is actually meaningful. A 0 usually means
                          no score was reported (e.g. eXe's Padlock game never commits one), so
                          showing "0%" reads like a real grade of zero. */}
                      {st?.scoreRaw ? (
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{st.scoreRaw}%</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <iframe
          ref={iframeRef}
          title="Course content"
          src={`/learning/play/${courseId}/${scos[0].href}`}
          className="h-[80vh] w-full rounded-xl border border-border"
        />
      </div>
    </div>
  );
}

/** Point an iframe at about:blank and resolve once that blank document has loaded. */
function blankIframe(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const onLoad = () => {
      iframe.removeEventListener("load", onLoad);
      resolve();
    };
    iframe.addEventListener("load", onLoad);
    iframe.src = "about:blank";
  });
}
