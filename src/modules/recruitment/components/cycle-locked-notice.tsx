import type { ReactElement } from "react";
import { Lock } from "lucide-react";
import { requirePersonSession } from "@/platform/auth/session";
import { EmptyState } from "@/platform/ui/empty-state";
import { TextLink } from "@/platform/ui/text-link";
import { CYCLE_LOCKED_MESSAGE, CYCLE_WIDE_EXCEPTED_MESSAGE, cycleReviewLock } from "../services/review-lock";

/**
 * For the top of every page in a cycle's workspace, after its permission gates:
 * the locked notice when the signed-in person applied in this cycle and holds no
 * exception, else null. The whole workspace locks, setup pages included, so the
 * cycle reads the same wherever they land; the services refuse independently.
 *
 *   const locked = await lockedCycleView(id);
 *   if (locked) return locked;
 */
export async function lockedCycleView(
  cycleId: string,
  opts: { cycleWide?: boolean } = {},
): Promise<ReactElement | null> {
  const session = await requirePersonSession();
  const lock = await cycleReviewLock(cycleId, session.personId);
  if (lock.state === "locked") return <CycleLockedNotice netIdOnly={lock.netIdOnly} />;
  // Cycle-wide pages (Decisions, Onboarding, Subcommittees) touch every
  // applicant at once, the holder's own included, so an exception does not
  // reach them (assertCycleClear).
  if (opts.cycleWide && lock.state === "excepted") {
    return (
      <EmptyState
        bordered
        icon={Lock}
        title="Another recruitment lead runs this step."
        description={CYCLE_WIDE_EXCEPTED_MESSAGE}
      />
    );
  }
  return null;
}

/**
 * What someone who applied in a cycle sees on any of its pages instead of its
 * applicants (services/review-lock.ts). A calm explanation rather than a 404 or
 * an error: being locked out is expected, not a fault. Every cycle page renders
 * this itself, because a layout cannot stop the page beneath it from rendering.
 */
export function CycleLockedNotice({ netIdOnly = false }: { netIdOnly?: boolean } = {}) {
  return (
    <EmptyState
      bordered
      icon={Lock}
      title={CYCLE_LOCKED_MESSAGE}
      description={
        netIdOnly
          ? "An application in this cycle lists your NetID. If you did not apply, ask a recruitment lead to check that application's NetID, because a mistyped one locks the wrong person out. Until then, recruitment leads who did not apply run this cycle."
          : "Recruitment leads who did not apply run this cycle. If you need access to it for a logistical reason within your department, your ED can ask a recruitment lead for a review exception. Even then, your own application stays hidden from you."
      }
      action={<TextLink href="/recruitment">Back to Recruitment</TextLink>}
    />
  );
}
