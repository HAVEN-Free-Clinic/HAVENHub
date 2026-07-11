import type { ApplicantStatusView } from "./portal-status";

export type TrackerNodeStatus = "done" | "current" | "upcoming";
export type TrackerNodeKey = "submitted" | "in_review" | "interview" | "decision";
export type TrackerNode = { key: TrackerNodeKey; label: string; status: TrackerNodeStatus };
export type TrackerStage = {
  showTracker: boolean;
  nodes: TrackerNode[];
  terminal: "accepted" | "waitlisted" | "not_selected" | null;
};

const LABELS: Record<TrackerNodeKey, string> = {
  submitted: "Submitted",
  in_review: "In review",
  interview: "Interview",
  decision: "Decision",
};
const ORDER: TrackerNodeKey[] = ["submitted", "in_review", "interview", "decision"];

// currentIndex = which node is highlighted; every earlier node is done. A null
// currentIndex with allDone marks a terminal all-complete state.
function build(statuses: TrackerNodeStatus[], terminal: TrackerStage["terminal"]): TrackerStage {
  return {
    showTracker: true,
    nodes: ORDER.map((key, i) => ({ key, label: LABELS[key], status: statuses[i] })),
    terminal,
  };
}

export function trackerStageFor(state: ApplicantStatusView["state"]): TrackerStage {
  switch (state) {
    case "DRAFT":
      return { showTracker: false, nodes: [], terminal: null };
    case "SUBMITTED":
      return build(["done", "current", "upcoming", "upcoming"], null);
    case "INTERVIEW":
      return build(["done", "done", "current", "upcoming"], null);
    case "WAITLISTED":
      return build(["done", "done", "done", "current"], "waitlisted");
    case "NOT_SELECTED":
      return build(["done", "done", "done", "done"], "not_selected");
    case "ACCEPTED":
    case "ONBOARDING":
      return build(["done", "done", "done", "done"], "accepted");
  }
}
