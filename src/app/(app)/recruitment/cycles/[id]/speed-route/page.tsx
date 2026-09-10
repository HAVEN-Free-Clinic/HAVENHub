import { notFound } from "next/navigation";
import { PageBody } from "@/platform/ui/page-body";
import { requirePersonSession } from "@/platform/auth/session";
import { can } from "@/platform/rbac/engine";
import { loadSpeedRouteBoard } from "@/modules/recruitment/services/speed-route";
import { RecruitmentAuthError } from "@/modules/recruitment/services/review";
import { RoutingError } from "@/modules/recruitment/services/routing";
import { SetBreadcrumb } from "@/platform/ui/breadcrumb-context";
import { cycleTrail } from "@/modules/recruitment/breadcrumbs";
import { PageHeader } from "@/platform/ui/page-header";
import { Card } from "@/platform/ui/card";
import { SectionHeader } from "@/platform/ui/section-header";
import { Input } from "@/platform/ui/input";
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
import { FormRow, RowField } from "@/platform/ui/form";

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
  // loadSpeedRouteBoard gates on recruitment.review_all, NOT recruitment.access,
  // so a review_all holder without access can reach this page while the cycle
  // overview would bounce them. The breadcrumb must not link there for them.
  const canOpenOverview = await can(person.personId, "recruitment.access");
  const middlePercent = Math.max(0, 100 - board.topPercent - board.bottomPercent);
  return (
    <PageBody>
      <SetBreadcrumb
        trail={cycleTrail({ canOpenOverview, cycleId: id, cycleTitle: board.title, section: { label: "Speed route", slug: "speed-route" } })}
      />
      <PageHeader title="Speed route" description={board.title} />

      <Card>
        <SectionHeader>Thresholds</SectionHeader>
        <p className="mt-1 text-xs text-subtle-foreground">
          Top {board.topPercent}% route to a department, bottom {board.bottomPercent}% auto-reject, middle {middlePercent}% you decide. Ties never split, so tier counts can exceed the percentage.
        </p>
        <form action={setRouteThresholdsAction.bind(null, id)}>
          <FormRow className="mt-3">
            <RowField label="Top %" width="numeric">
              <Input name="topPercent" type="number" min={0} max={100} defaultValue={board.topPercent} />
            </RowField>
            <RowField label="Bottom %" width="numeric">
              <Input name="bottomPercent" type="number" min={0} max={100} defaultValue={board.bottomPercent} />
            </RowField>
            <SubmitButton size="sm" pendingLabel="Saving…">Save thresholds</SubmitButton>
          </FormRow>
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
    </PageBody>
  );
}
