"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { RecruitmentAuthError, AcceptanceError } from "@/modules/recruitment/services/review";
import {
  routeApplication,
  rejectApplication,
  reopenDecision,
  applyTierRoutes,
  applyTierRejects,
  RoutingError,
  type BatchResult,
} from "@/modules/recruitment/services/routing";
import { setRouteThresholds, RouteThresholdError } from "@/modules/recruitment/services/route-thresholds";

function messageIfKnown(err: unknown): string | null {
  if (err instanceof RecruitmentAuthError || err instanceof RoutingError || err instanceof AcceptanceError) {
    return err.message;
  }
  return null;
}

export async function speedRouteRouteAction(applicationId: string, departmentCode: string): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await routeApplication(applicationId, departmentCode, person.personId);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function speedRouteRejectAction(applicationId: string, notes: string | null = null): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await rejectApplication(applicationId, person.personId, notes && notes.trim() ? notes.trim() : null);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function speedRouteReopenAction(applicationId: string): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  try {
    await reopenDecision(applicationId, person.personId);
    return {};
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function applyTopTierAction(
  entries: { applicationId: string; departmentCode: string }[],
): Promise<BatchResult | { error: string }> {
  const person = await requirePersonSession();
  try {
    return await applyTierRoutes(entries, person.personId);
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function applyBottomTierAction(applicationIds: string[]): Promise<BatchResult | { error: string }> {
  const person = await requirePersonSession();
  try {
    return await applyTierRejects(applicationIds, person.personId, null);
  } catch (err) {
    const m = messageIfKnown(err);
    if (m) return { error: m };
    throw err;
  }
}

export async function setRouteThresholdsAction(cycleId: string, formData: FormData): Promise<void> {
  const person = await requirePersonSession();
  const top = Number(formData.get("topPercent"));
  const bottom = Number(formData.get("bottomPercent"));
  const base = `/recruitment/cycles/${cycleId}/speed-route`;
  try {
    await setRouteThresholds(cycleId, top, bottom, person.personId);
  } catch (err) {
    if (err instanceof RouteThresholdError || err instanceof RecruitmentAuthError) {
      redirect(`${base}?error=${encodeURIComponent((err as Error).message)}`);
    }
    throw err;
  }
  revalidatePath(base);
}
