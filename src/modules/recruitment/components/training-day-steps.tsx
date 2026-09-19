import Link from "next/link";
import type { TrainingPartStatus } from "@prisma/client";
import { Alert } from "@/platform/ui/alert";
import { buttonClasses } from "@/platform/ui/button";
import { formatDateOnly } from "@/platform/dates";
import type { MyTraining } from "../services/training";

/** How a satisfied part reads back to the member. */
const DONE_COPY: Partial<Record<TrainingPartStatus, string>> = {
  ATTENDED: "Attended",
  ONLINE_COURSE: "Completed online",
  QUIZ: "Completed by makeup quiz",
  MARKED_OFF: "Marked off",
  NOT_REQUIRED: "Not required for you",
};

/**
 * What a member with training still open has left, part by part.
 *
 * Shared by /training and /get-started/training so the two cannot drift, which
 * matters here more than usual: the copy differs by whether training day has
 * happened, whether the absence was excused, and whether they are new or
 * returning, and a member who reads one thing on the dashboard and another on
 * the checklist will act on whichever is wrong.
 *
 * `learningBase` is where the makeup course lives for the caller: gated members
 * can only reach /get-started paths, so the checklist links under it.
 */
export function TrainingDaySteps({
  my,
  zone,
  learningBase,
}: {
  my: MyTraining;
  zone: string;
  learningBase: "/learning" | "/get-started/learning";
}) {
  const date = my.inPersonTrainingDate ? formatDateOnly(my.inPersonTrainingDate, zone) : null;
  const onDate = date ? ` on ${date}` : "";

  return (
    <div className="space-y-3">
      <PartLine label="Morning session" part={my.morning} />
      {my.morning === "OWED" &&
        (!my.sessionHeld ? (
          <Alert tone="info">Attend the in-person training session{onDate}.</Alert>
        ) : (
          <>
            {my.excused ? (
              <Alert tone="warning">
                You were excused from the in-person training{onDate}. You still need to make it up
                by completing the online makeup course.
              </Alert>
            ) : (
              <Alert tone="error">
                You missed the in-person training{onDate} without an excuse. That is unacceptable:
                training is required of every volunteer, and you cannot be scheduled for shifts
                until you complete the online makeup course.
              </Alert>
            )}
            <MakeupCourse my={my} learningBase={learningBase} />
          </>
        ))}

      {my.mockClinic !== "NOT_REQUIRED" && my.mockClinic !== null && (
        <PartLine label="Mock clinic" part={my.mockClinic} />
      )}
      {my.mockClinic === "OWED" &&
        (!my.sessionHeld ? (
          <Alert tone="info">Attend the afternoon mock clinic{onDate}.</Alert>
        ) : my.returning ? (
          <Alert tone="warning">
            You missed mock clinic. As a returning volunteer you do not need to make it up, but it
            has to be marked off before you are cleared: ask your director to contact IT to mark it
            off.
          </Alert>
        ) : (
          <Alert tone="warning">
            You missed mock clinic. Contact your director to arrange a make-up. Once you have done
            it, your director will ask IT to mark it off and this step will clear.
          </Alert>
        ))}
    </div>
  );
}

function PartLine({ label, part }: { label: string; part: TrainingPartStatus | null }) {
  const done = part && part !== "OWED" ? DONE_COPY[part] : null;
  return (
    <p className="text-sm text-foreground-soft">
      <span className="font-semibold text-foreground">{label}:</span> {done ?? "Still to do"}
    </p>
  );
}

function MakeupCourse({ my, learningBase }: { my: MyTraining; learningBase: string }) {
  if (my.locked) {
    return (
      <Alert tone="error">
        Your makeup course is locked after too many failed quiz attempts. Ask your director to reset
        it.
      </Alert>
    );
  }
  if (!my.makeupCourseId) {
    return (
      <Alert tone="info">
        The online makeup course is not available yet. This page will link to it as soon as it is.
      </Alert>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm leading-relaxed text-foreground-soft">
        The course is the recorded training in two sections, each followed by a short quiz. You must
        watch each video all the way through; you cannot skip ahead, and your place is saved if you
        stop.
      </p>
      <Link href={`${learningBase}/${my.makeupCourseId}`} className={buttonClasses("primary", "md")}>
        Start the online makeup course
      </Link>
    </div>
  );
}
