"use client";

import { useState } from "react";
import { X, Check, ClipboardCheck } from "lucide-react";

type ChecklistSection = { title: string; items: string[] };

function buildSections(site: {
  name: string;
  system: string | null;
  phone: string | null;
  address: string;
}): ChecklistSection[] {
  const isYNHH = site.system === "YNHH";

  return [
    {
      title: "Before the referral",
      items: [
        "Confirm attending physician has reviewed the case and agrees referral is appropriate",
        `Check patient insurance / Free Care status — MDIC team can assist${isYNHH ? " (required for YNHH visits)" : ""}`,
        "Identify any language support needed — note in referral",
      ],
    },
    {
      title: "Submitting the referral",
      items: isYNHH
        ? [
            "Attending submits referral in Epic — required for all YNHH specialists",
            "Include clinical summary and specific question for specialist",
            "Flag urgency level explicitly if urgent pathway may apply",
            "Attach recent relevant labs or imaging reports",
          ]
        : [
            `Call ${site.phone ?? "the office"} or have patient call directly`,
            "Mention HAVEN referral when scheduling",
            "Confirm sliding scale / payment arrangement",
            "Note any language or interpretation needs",
          ],
    },
    {
      title: "Before the appointment",
      items: [
        `Confirm patient knows the address: ${site.address}`,
        isYNHH
          ? "Patient brings Free Care approval letter to appointment"
          : "Patient brings any HAVEN care summary or medication list",
        "Confirm patient knows the appointment date and how to get there",
        "Give patient coordinator contact in case of questions between now and appointment",
      ],
    },
    {
      title: "After the referral",
      items: [
        "Document referral in Epic with expected timeframe",
        "Flag for follow-up at next HAVEN visit — confirm patient attended",
        "Close the loop: did patient get care? If not, what happened?",
      ],
    },
  ];
}

export function ReferralChecklistModal({
  site,
}: {
  site: { name: string; specialty: string; system: string | null; phone: string | null; address: string };
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const sections = buildSections(site);

  function toggle(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
      >
        <ClipboardCheck className="h-4 w-4" aria-hidden />
        Referral checklist
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-surface shadow-xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-surface px-6 py-4">
              <p className="text-sm font-semibold text-foreground">Referral checklist — {site.name}</p>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="px-6 py-5 space-y-6">
              <p className="text-sm text-muted-foreground">
                Referral to <strong className="text-foreground">{site.name}</strong> · {site.specialty}
              </p>

              {sections.map((section, si) => (
                <div key={section.title}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-subtle-foreground mb-2">
                    {section.title}
                  </p>
                  <div className="space-y-1">
                    {section.items.map((item, ii) => {
                      const key = `${si}-${ii}`;
                      const isChecked = checked[key] ?? false;
                      return (
                        <div
                          key={key}
                          className="flex items-start gap-3 py-1.5 text-sm text-foreground cursor-pointer"
                          onClick={() => toggle(key)}
                        >
                          <span
                            className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                              isChecked ? "bg-brand border-brand text-white" : "border-border-strong"
                            }`}
                          >
                            {isChecked && <Check className="h-3 w-3" aria-hidden />}
                          </span>
                          {item}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              <p className="text-xs italic text-muted-foreground pt-2 border-t border-border">
                Check off each item as you complete it. This checklist is for this session only — it does not save.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}