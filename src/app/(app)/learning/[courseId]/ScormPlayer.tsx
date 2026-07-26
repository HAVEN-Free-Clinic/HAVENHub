"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
import { Alert } from "@/platform/ui/alert";
import { deriveStatus, parseScore } from "@/modules/learning/engine/status";
import type { CmiSnapshot, LearnerSco } from "@/modules/learning/services/enrollment";

const EMPTY_SNAPSHOT: CmiSnapshot = { lessonStatus: null, scoreRaw: null, suspendData: null, lessonLocation: null };

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
  // The checkmarks/completion banner render from optimistic `live` state. If a
  // persist actually fails, that success is a lie (progress is lost on reload and
  // the learner stays un-cleared), so track the last save's outcome and warn.
  const [saveFailed, setSaveFailed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const apiRef = useRef<InstanceType<typeof Scorm12API> | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const switchingRef = useRef(false);
  const saveActiveRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // The active SCO id and a getter for its live CMI, so the unload beacon below can
  // flush the current SCO without going through the (unload-cancellable) server action.
  const activeScoIdRef = useRef<string>(scos[0]?.id ?? "");
  const snapshotRef = useRef<() => CmiSnapshot>(() => EMPTY_SNAPSHOT);

  // Build a fresh API for one SCO: seed saved state, mirror live writes into React
  // state, wire commit/finish persistence (tagged with this SCO's id), install as window.API.
  const installApi = useCallback((sco: LearnerSco) => {
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
      const p = persistCmiAction(courseId, sco.id, snapshot())
        .then(() => setSaveFailed(false))
        .catch(() => setSaveFailed(true));
      pendingSaveRef.current = p;
      return p;
    };
    // Persist the moment a page/quiz writes lesson_status -- that is the completion
    // signal that unblocks onboarding, and snapshot() also captures the score written
    // alongside it -- so a completion is durable within a round-trip instead of waiting
    // up to the 30s autocommit (or a never-fired LMSCommit) (#18). Score-only writes
    // still just mirror to the UI; the next lesson_status/commit persists them.
    api.on("LMSSetValue.cmi.core.lesson_status", save);
    api.on("LMSSetValue.cmi.core.score.raw", sync);
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    (window as unknown as { API: typeof api }).API = api;
    apiRef.current = api;
    saveActiveRef.current = save;
    activeScoIdRef.current = sco.id;
    snapshotRef.current = snapshot;
    return save;
  }, [courseId]);

  // Initial mount: install the first SCO's API before paint, so the iframe (which
  // renders with the first SCO's src) finds window.API on load. Unmount: persist + remove.
  useLayoutEffect(() => {
    installApi(scos[0]);
    return () => {
      saveActiveRef.current();
      delete (window as unknown as { API?: unknown }).API;
      apiRef.current = null;
    };
  }, [installApi, scos]);

  // Durability backstop for tab close / bfcache: the server-action save() fetch is
  // cancelled as the document unloads, so a completion the learner just earned on the
  // final SCO can be lost. pagehide / visibilitychange(hidden) flush the current SCO's
  // live CMI via navigator.sendBeacon, which is delivered by the browser even during
  // unload. The iframe's own unload fires first (writing lesson_status="completed" on
  // window.API), so the snapshot we read here already reflects it (#18).
  useEffect(() => {
    function flush() {
      const payload = JSON.stringify({
        courseId,
        scoId: activeScoIdRef.current,
        cmi: snapshotRef.current(),
      });
      navigator.sendBeacon?.("/api/learning/persist-cmi", new Blob([payload], { type: "application/json" }));
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") flush();
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [courseId]);

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
  const allComplete =
    scos.length > 0 &&
    scos.every((s) => {
      const liveCompleted = deriveStatus(live[s.id]?.lessonStatus).completed;
      const persistedCompleted = deriveStatus(s.cmi.lessonStatus).completed;
      return liveCompleted || persistedCompleted;
    });

  return (
    <div className="space-y-4">
      {saveFailed && (
        <Alert tone="warning">
          Your progress could not be saved. Check your connection, your latest changes may not be
          recorded.
        </Alert>
      )}
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
                    <button type="button" onClick={() => goTo(i)} aria-current={isActive ? "page" : undefined} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${isActive ? "bg-brand-faint font-medium text-brand-fg" : "text-foreground-soft hover:bg-muted"}`}>
                      <span
                        aria-hidden
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                          done ? "border-brand bg-brand text-white" : "border-border-strong text-subtle-foreground"
                        }`}
                      >
                        {done ? <Check className="h-4 w-4" /> : i + 1}
                      </span>
                      <span className="truncate">{s.title}</span>
                      {/* Show a score whenever one is present, including 0.
                          We intentionally hide only null/undefined until the data model can
                          distinguish "no score reported" from "reported score of zero". */}
                      {st?.scoreRaw != null ? (
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
          sandbox="allow-scripts allow-same-origin allow-forms"
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
