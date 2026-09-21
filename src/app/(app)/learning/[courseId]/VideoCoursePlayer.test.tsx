// @vitest-environment jsdom
/**
 * The player's end-of-section handling, which once flooded the heartbeat.
 *
 * Reaching a section's end used to pause, seek back to the end, and report,
 * on EVERY timeupdate. A seek fires another timeupdate (even a seek to where
 * the video already is), so a video parked at a section's end re-entered that
 * branch forever: thousands of heartbeats a minute from one open tab. Each was
 * a Serializable write to the rows a quiz submission reads, so the quiz
 * transaction lost every retry and learners could not submit (2026-09-21).
 *
 * jsdom has no media engine, so the <video> here is stubbed to do what the
 * HTML spec says a browser does: setting currentTime queues `seeking` and
 * `timeupdate`, and pausing a playing video queues `pause`.
 *
 * Bare createRoot + act(), following confirm-button.test.tsx: this repo has no
 * @testing-library/react.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LearnerVideoCourse, LearnerVideoSection } from "@/modules/learning/services/video-progress";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../actions", () => ({ submitSectionQuizAction: vi.fn() }));

import { VideoCoursePlayer } from "./VideoCoursePlayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const START = 4635;
const LENGTH = 2795;
const END = START + LENGTH;

function course(watched: boolean): LearnerVideoCourse {
  const section: LearnerVideoSection = {
    id: "sec-hipaa",
    title: "HIPAA Training",
    videoId: "vid-1",
    hasCaptions: false,
    startSeconds: START,
    length: LENGTH,
    watchedSeconds: watched ? LENGTH : LENGTH - 8,
    state: { id: "sec-hipaa", unlocked: true, watched, passed: false, quizOpen: watched },
    questions: [{ id: "q1", prompt: "Who may see PHI?", options: [{ value: "a", label: "The care team" }] }],
    passPercent: 80,
    attemptsUsed: 0,
    maxAttempts: 3,
  };
  return {
    id: "course-1",
    title: "Makeup",
    description: null,
    status: "IN_PROGRESS",
    isMakeup: true,
    complete: false,
    locked: false,
    preview: false,
    sections: [section],
  };
}

/** Make the rendered <video> behave like a browser's, as far as these events go. */
function stubMedia(video: HTMLVideoElement) {
  let time = START;
  let paused = false;
  const queue = (type: string) => setTimeout(() => video.dispatchEvent(new Event(type)), 0);
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => time,
    set: (t: number) => {
      time = t;
      queue("seeking");
      queue("timeupdate");
    },
  });
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "ended", { configurable: true, get: () => false });
  video.pause = () => {
    if (paused) return;
    paused = true;
    queue("pause");
  };
  return {
    /** Playback advancing on its own, the way the media engine reports it. */
    playTo(t: number) {
      time = t;
      video.dispatchEvent(new Event("timeupdate"));
    },
  };
}

type Heartbeat = { courseId: string; sectionId: string; reachedSeconds: number };

let mounted: { container: HTMLDivElement; root: Root } | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
let replies: { watchedSeconds: number; complete: boolean }[];

function heartbeats(): Heartbeat[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Heartbeat);
}

function mount(watched: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<VideoCoursePlayer course={course(watched)} />));
  mounted = { container, root };
  const video = container.querySelector("video");
  if (!video) throw new Error("no <video> rendered");
  return { container, media: stubMedia(video) };
}

/** Let queued media events (and whatever they queue in turn) run. One
 *  millisecond per round, because fake timers schedule a 0 ms timeout queued
 *  from inside a timer 1 ms out. Fifty rounds stay far short of a heartbeat. */
async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  replies = [];
  fetchMock = vi.fn(async () => {
    const reply = replies.shift() ?? { watchedSeconds: LENGTH, complete: true };
    return { ok: true, json: async () => reply } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reports reaching a section's end once, instead of on every timeupdate after it", async () => {
  const { media } = mount(true);

  media.playTo(END + 0.2);
  await settle();

  expect(heartbeats()).toEqual([{ courseId: "course-1", sectionId: "sec-hipaa", reachedSeconds: LENGTH }]);
});

it("keeps reporting from the end every heartbeat until the server credits the section, then stops", async () => {
  // The report sent on reaching the end can fall short of the server's real-time
  // allowance (or fail outright). The player must not strand the learner there.
  replies = [{ watchedSeconds: LENGTH - 3, complete: false }];
  const { container, media } = mount(false);

  media.playTo(END + 0.2);
  await settle();
  expect(heartbeats()).toHaveLength(1);
  expect(container.textContent).not.toContain("Submit quiz");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(heartbeats()).toHaveLength(2);
  expect(container.textContent).toContain("Submit quiz");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(heartbeats()).toHaveLength(2);
});
