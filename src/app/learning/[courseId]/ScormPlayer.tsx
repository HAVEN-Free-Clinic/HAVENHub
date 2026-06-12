"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
import { deriveStatus, parseScore } from "@/modules/learning/engine/status";
import type { LearnerSco } from "@/modules/learning/services/enrollment";

type Props = {
  courseId: string;
  scos: LearnerSco[];
};

/**
 * Hosts a SCORM 1.2 runtime as window.API and renders one SCO at a time in an
 * iframe, with a table of contents for multi-SCO packages.
 *
 * SCO switching (goTo) does an in-page handoff rather than a remount/reload: we
 * point the iframe at about:blank first, so the outgoing SCO unloads and fires
 * LMSFinish against the still-current window.API (eXeLearning stamps completion in
 * its unloadPage). Because only the iframe navigates -- not the parent -- the
 * persistence fetch issued from this component survives. We then install the next
 * SCO's API and point the iframe at it.
 */
export function ScormPlayer({ courseId, scos }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const apiRef = useRef<InstanceType<typeof Scorm12API> | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const switchingRef = useRef(false);
  const saveActiveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Build a fresh API for one SCO: seed saved state, wire commit/finish
  // persistence (tagged with this SCO's id), and install it as window.API.
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
    const save = () => {
      const p = persistCmiAction(courseId, sco.id, snapshot()).catch(() => {});
      pendingSaveRef.current = p;
      return p;
    };
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
      await blankIframe(iframe); // outgoing SCO unloads -> LMSFinish on current API
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

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      {!single && (
        <nav aria-label="Course pages" className="md:w-56 md:shrink-0">
          <ol className="space-y-1">
            {scos.map((s, i) => {
              const isActive = i === activeIndex;
              // Reflects the SCO status from the initial server render; updates on
              // next page load, not live after an in-page switch (by design).
              const done = deriveStatus(s.cmi.lessonStatus).completed;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                      isActive
                        ? "bg-teal-50 font-medium text-teal-800"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                        done ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 text-slate-400"
                      }`}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
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
        className="h-[80vh] w-full rounded-xl border border-slate-200"
      />
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
