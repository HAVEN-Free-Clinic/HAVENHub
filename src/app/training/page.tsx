import { requirePersonSession } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyTraining } from "@/modules/recruitment/services/training";
import { submitQuizAction } from "./actions";

export default async function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<{ passed?: string; score?: string; err?: string }>;
}) {
  const person = await requirePersonSession();
  const sp = await searchParams;
  const my = await getMyTraining(person.personId);

  return (
    <AppShell userName={person.name} termLabel={my.term.name}>
      <PageHeader
        title="Volunteer Training"
        description="Complete training to be cleared for the term."
      />
      <div className="mt-6 max-w-2xl space-y-4 text-sm">
        {sp.err && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">
            {sp.err}
          </p>
        )}
        {sp.passed && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-green-800">
            You passed. Training is complete.
          </p>
        )}
        {sp.score && !sp.passed && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
            You scored {sp.score}%. Try again.
          </p>
        )}

        {!my.cycle && <p className="text-slate-500">Training is not open yet for this term.</p>}

        {my.cycle && my.state === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-green-800">
            Training complete{my.completedVia ? ` (via ${my.completedVia.toLowerCase()})` : ""}. You are cleared on the training requirement.
          </p>
        )}

        {my.cycle && my.state !== "COMPLETE" && my.locked && (
          <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">
            Your quiz is locked after {my.maxAttempts} attempts. Contact your director to reset it.
          </p>
        )}

        {my.cycle && my.state !== "COMPLETE" && !my.locked && (
          <form action={submitQuizAction} className="space-y-5">
            <p className="text-slate-500">
              If you attended the live session, your director will mark your attendance. Otherwise, complete this makeup quiz (need {my.passPercent}%, {my.maxAttempts - my.attemptsUsed} attempt(s) left).
            </p>
            {my.questions.map((q) => (
              <fieldset key={q.key} className="space-y-1">
                <legend className="font-medium">{q.label}</legend>
                {q.options.map((o) => (
                  <label key={o.value} className="flex items-center gap-2">
                    <input type="radio" name={`q:${q.key}`} value={o.value} required /> {o.label}
                  </label>
                ))}
              </fieldset>
            ))}
            <div className="space-y-2 border-t pt-4">
              <p className="font-medium">A few quick questions</p>
              <input name="subcommitteeInterest" placeholder="Subcommittee interest" className="w-full rounded border px-2 py-1" />
              <input name="minShiftsWanted" placeholder="Minimum shifts wanted" className="w-full rounded border px-2 py-1" />
              <input name="additionalShiftAvailability" placeholder="Additional shift availability" className="w-full rounded border px-2 py-1" />
              <textarea name="feedback" placeholder="Feedback or questions" className="w-full rounded border px-2 py-1" />
            </div>
            <button className="rounded-md bg-slate-900 px-3 py-1.5 text-white">Submit quiz</button>
          </form>
        )}
      </div>
    </AppShell>
  );
}
