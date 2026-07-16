/**
 * OnboardingStepsEditor: server component for customizing a term's onboarding
 * checklist. One row per step (the six built-in kinds): show/hide, relabel, make
 * blocking or optional, and reorder. Posts all rows to a single server action.
 */

import { Input } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { Button } from "@/platform/ui/button";
import { Table, THead, TR, TH, TD } from "@/platform/ui/table";
import { STEP_DEFAULTS, type EffectiveStep } from "@/modules/onboarding/services/step-config";

export function OnboardingStepsEditor({
  steps,
  saveAction,
  saved,
}: {
  steps: EffectiveStep[];
  saveAction: (formData: FormData) => Promise<void>;
  saved?: boolean;
}) {
  return (
    <form action={saveAction} className="space-y-3">
      <p className="text-sm text-foreground-soft">
        Customize the onboarding checklist for this term. Uncheck a step to hide it, rename it, make it optional (non-blocking), or change its order. Leave a label blank to use the default. Volunteer and director training are separate steps.
      </p>
      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH>Step</TH>
              <TH>Shown</TH>
              <TH>Label</TH>
              <TH>Blocking</TH>
              <TH>Order</TH>
            </TR>
          </THead>
          <tbody>
            {steps.map((s) => {
              const def = STEP_DEFAULTS[s.kind];
              return (
                <TR key={s.kind}>
                  <TD className="text-sm font-medium text-foreground">{def.label}</TD>
                  <TD>
                    <Checkbox name={`step.${s.kind}.enabled`} defaultChecked={s.enabled} aria-label={`Show ${def.label}`} />
                  </TD>
                  <TD>
                    <Input
                      name={`step.${s.kind}.label`}
                      defaultValue={s.hasOverride && s.label !== def.label ? s.label : ""}
                      placeholder={def.label}
                      aria-label={`${def.label} label`}
                      className="min-w-[14rem]"
                    />
                  </TD>
                  <TD>
                    <Checkbox name={`step.${s.kind}.blocking`} defaultChecked={s.blocking} aria-label={`${def.label} blocks clearance`} />
                  </TD>
                  <TD>
                    <Input
                      type="number"
                      name={`step.${s.kind}.order`}
                      defaultValue={String(s.order)}
                      aria-label={`${def.label} order`}
                      className="w-20"
                    />
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </div>
      {saved && <p className="text-sm text-success-foreground">Onboarding steps saved.</p>}
      <Button type="submit" variant="primary" size="sm">
        Save onboarding steps
      </Button>
    </form>
  );
}
