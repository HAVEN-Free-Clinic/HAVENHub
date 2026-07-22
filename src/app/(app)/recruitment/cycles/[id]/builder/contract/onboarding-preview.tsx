"use client";

import { useMemo, useState } from "react";
import type { EpicRequirement, Track } from "@prisma/client";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { Select } from "@/platform/ui/select";
import { Field } from "@/platform/ui/input";
import { ContractField } from "@/app/onboard/[token]/contract-field";
import { visibleOnboardingBlocks } from "@/modules/recruitment/contract/visibility";
import { epicRequirementFor } from "@/modules/recruitment/contract/epic-requirement";
import type { ContractLayout } from "@/modules/recruitment/contract/layout";

export type PreviewDepartment = {
  code: string;
  name: string;
  requiresEpicDirector: EpicRequirement;
  requiresEpicVolunteer: EpicRequirement;
};

export type OnboardingPreviewContext = {
  departments: PreviewDepartment[];
  orgName: string;
  trainingDate: string;
  trainingLocation: string;
  todayIso: string;
  title: string;
  /** The cycle's track locks the control; null (global master template) offers a toggle. */
  fixedTrack: Track | null;
};

const EMPTY_PREFILL = { firstName: "", lastName: "", email: "", netId: "", phone: "", yaleAffiliation: "", gradYear: "" };
const noErr = () => undefined;

function trackLabel(t: Track): string {
  return t === "DIRECTOR" ? "Director" : "Volunteer";
}

/**
 * A read-only-but-interactive preview of the onboarding contract, rendered from
 * the builder's in-hand layout through the SAME ContractField renderer and the
 * visibleOnboardingBlocks helper the live /onboard form's render is built from.
 * Staff pick a track + accepted department (which derive the Epic requirement),
 * and can fill fields so conditional (visibleWhen) blocks reveal exactly as an
 * applicant would experience them. Nothing is saved.
 *
 * Split from the Modal wrapper so it can be rendered directly in a static test
 * (Modal renders through a portal, which react-dom/server does not capture).
 */
export function OnboardingPreviewBody({
  layout,
  departments,
  orgName,
  trainingDate,
  trainingLocation,
  todayIso,
  title,
  fixedTrack,
}: OnboardingPreviewContext & { layout: ContractLayout }) {
  const [track, setTrack] = useState<Track>(fixedTrack ?? "VOLUNTEER");
  const [departmentCode, setDepartmentCode] = useState<string>(departments[0]?.code ?? "");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const selectedDept = departments.find((d) => d.code === departmentCode) ?? null;
  const epicRequirement = epicRequirementFor(selectedDept, track);
  const department = departmentCode || null;
  const ctx = { firstName: "", orgName, todayIso, trainingDate, trainingLocation, department, track, epicRequirement };

  const shown = useMemo(
    () => visibleOnboardingBlocks(layout, answers, { department, track, epicRequirement }),
    [layout, answers, department, track, epicRequirement],
  );
  const departmentCodes = departments.map((d) => d.code);
  const onAnswer = (name: string, value: string | string[]) => setAnswers((prev) => ({ ...prev, [name]: value }));

  return (
    <>
      <p className="text-sm text-muted-foreground">
        This is how accepted applicants see the <span className="font-medium text-foreground">{title}</span> onboarding
        contract. Nothing here is saved. Fill fields to see conditional blocks appear as an applicant would.
      </p>

      <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/40 p-3">
        <div>
          <span className="text-xs font-medium text-foreground">Track</span>
          {fixedTrack ? (
            <p className="mt-1 text-sm text-foreground-soft">{trackLabel(fixedTrack)}</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {(["VOLUNTEER", "DIRECTOR"] as Track[]).map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={track === t ? "primary" : "outline"}
                  onClick={() => setTrack(t)}
                >
                  {trackLabel(t)}
                </Button>
              ))}
            </div>
          )}
        </div>
        {departments.length > 0 && (
          <div className="max-w-xs">
            <Field label="Accepted department" hint={`Epic requirement: ${epicRequirement}`}>
              <Select value={departmentCode} onChange={(e) => setDepartmentCode(e.target.value)}>
                {departments.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </div>

      {/* Submit is suppressed: the form element only exists so grouped controls
          (MULTI_SELECT / SUBCOMMITTEE_RANK) can read their sibling values back
          for live visibleWhen evaluation, mirroring ApplyPreview. */}
      <form className="mt-4" onSubmit={(e) => e.preventDefault()}>
        <Card className="space-y-6">
          {shown.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No blocks are shown for this context yet.</p>
          ) : (
            shown.map((b) => (
              <ContractField
                key={"id" in b ? b.id : b.kind === "system_field" ? b.systemKey : b.key}
                block={b}
                prefill={EMPTY_PREFILL}
                ctx={ctx}
                err={noErr}
                onAnswer={onAnswer}
                departments={departmentCodes}
              />
            ))
          )}
        </Card>
      </form>
    </>
  );
}

export function OnboardingPreview({
  open,
  onClose,
  ...body
}: { open: boolean; onClose: () => void } & OnboardingPreviewContext & { layout: ContractLayout }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Contract preview"
      size="large"
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Close preview
        </Button>
      }
    >
      <OnboardingPreviewBody {...body} />
    </Modal>
  );
}
