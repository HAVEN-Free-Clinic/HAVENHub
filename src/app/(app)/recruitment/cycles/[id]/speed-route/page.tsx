import { notFound } from "next/navigation";
import { requirePersonSession } from "@/platform/auth/session";
import { loadSpeedRouteBoard } from "@/modules/recruitment/services/speed-route";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { RoutingError } from "@/modules/recruitment/services/routing";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Field, Input } from "@/platform/ui/input";
import { SubmitButton } from "@/platform/ui/submit-button";
import { SpeedRouteBoard } from "@/modules/recruitment/components/speed-route-board";
import {
  speedRouteRouteAction,
  speedRouteRejectAction,
  speedRouteReopenAction,
  applyTopTierAction,
  applyBottomTierAction,
  setRouteThresholdsAction,
} from "./actions";

export default async function SpeedRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const person = await requirePersonSession();
  let board;
  try {
    board = await loadSpeedRouteBoard(id, person.personId);
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof RoutingError) notFound();
    throw err;
  }
  const middlePercent = Math.max(0, 100 - board.topPercent - board.bottomPercent);
  return (
    <div className="space-y-6">
      <SetBreadcrumb
        trail={cycleTrail({ cycleId: id, cycleTitle: board.title, section: { label: "Speed route", slug: "speed-route" } })}
      />
      <PageHeader title="Speed route" description={board.title} />

      <Card>
        <SectionHeader>Thresholds</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Top {board.topPercent}% route to a department, bottom {board.bottomPercent}% auto-reject, middle {middlePercent}% you decide. Ties never split, so tier counts can exceed the percentage.
        </p>
        <form action={setRouteThresholdsAction.bind(null, id)} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Field label="Top %">
              <Input name="topPercent" type="number" min={0} max={100} defaultValue={board.topPercent} />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Bottom %">
              <Input name="bottomPercent" type="number" min={0} max={100} defaultValue={board.bottomPercent} />
            </Field>
          </div>
          <SubmitButton size="sm" pendingLabel="Saving…">Save thresholds</SubmitButton>
        </form>
      </Card>

      <SpeedRouteBoard
        board={board}
        onRoute={speedRouteRouteAction}
        onReject={speedRouteRejectAction}
        onReopen={speedRouteReopenAction}
        onApplyTop={applyTopTierAction}
        onApplyBottom={applyBottomTierAction}
      />
    </div>
  );
}
