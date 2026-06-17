"use client";

/**
 * EpicRequestForm: interactive client component for the Epic request generator.
 *
 * Renders a three-step form:
 *   1. Select authorizer (CC / RT / JC) and request type (5 options)
 *   2. Select person(s) from the department/member tree
 *   3. Review the generated email draft and download the PDF (+ spreadsheet
 *      for bulk requests)
 *
 * PDF and spreadsheet generation happen server-side via the /api/admin/itcm/
 * generate route (returns a base64-encoded PDF and optional XLSX). The email
 * draft is assembled client-side from the same data since it needs no binary.
 *
 * The access end date is configurable via a date input so ITCM can set it
 * once per term without touching code.
 */

import { useState, useMemo } from "react";
import type { DepartmentWithMembers, MemberLite } from "@/modules/admin/services/itcm";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Input, Field } from "@/platform/ui/input";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORIZERS = {
  CC: { name: "Caprice Culkin", phone: "720-254-2589", email: "caprice.culkin@yale.edu" },
  RT: { name: "Renee Tracey", phone: "201-815-6054", email: "renee.tracey@yale.edu" },
  JC: { name: "Jack Carney", phone: "585-689-9720", email: "j.carney@yale.edu" },
} as const;
type AuthorizerKey = keyof typeof AUTHORIZERS;

type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod";


const EMAIL_SUBJECTS: Record<RequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `[HAVEN] New Epic Account Request ${i} ${d}`,
  mod_individual: (i, d) => `[HAVEN] Modify Epic Access for One User ${d} ${i}`,
  renew_individual: (i, d) => `[HAVEN] Renew Epic Access for One User ${d} ${i}`,
  bulk_mod: (i, d) => `[HAVEN] Reactivate/Extend and Modify Epic Access for Multiple Users ${d} ${i}`,
  bulk_new: (i, d) => `[HAVEN] Multiple New Epic Account Request ${d} ${i}`,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  departments: DepartmentWithMembers[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EpicRequestForm({ departments }: Props) {
  // Step 1: configuration
  const [authorizer, setAuthorizer] = useState<AuthorizerKey>("CC");
  const [requestType, setRequestType] = useState<RequestType>("new_individual");
  const [endDate, setEndDate] = useState("");

  // Step 2: person selection
  const [selectedDeptId, setSelectedDeptId] = useState<string>("");
  const [selectedPeopleIds, setSelectedPeopleIds] = useState<Set<string>>(new Set());

  // Step 3: results
  const [loading, setLoading] = useState(false);
  const [emailDraft, setEmailDraft] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType.includes("new");

  // The selected department's members for the person list.
  const selectedDept = useMemo(
    () => departments.find((d) => d.department.id === selectedDeptId),
    [departments, selectedDeptId]
  );

  // All selectable members for the current request type.
  // Directors and volunteers are shown separately since mirror logic is role-specific.
  const allMembers: MemberLite[] = useMemo(() => {
    if (!selectedDept) return [];
    return [...selectedDept.directors, ...selectedDept.volunteers];
  }, [selectedDept]);

  function togglePerson(id: string) {
    setSelectedPeopleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        // For individual requests, only one person at a time.
        if (!isBulk) next.clear();
        next.add(id);
      }
      return next;
    });
  }

  // Build a today string in MMDDYYYY format for filenames/subjects.
  function todayMMDDYYYY(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}${dd}${yyyy}`;
  }

  async function handleGenerate() {
    if (selectedPeopleIds.size === 0) {
      setError("Select at least one person before generating.");
      return;
    }
    if (!isNew && !endDate) {
      setError("Set the access end date before generating a modify/renew request.");
      return;
    }
    setError(null);
    setLoading(true);
    setEmailDraft(null);

    try {
      // endDate is held as an ISO YYYY-MM-DD string from the date input; the
      // server and PDF expect MM/DD/YYYY. Convert by slicing (not via Date) so
      // the calendar day the admin picked is preserved regardless of timezone.
      const endDateFormatted = endDate
        ? `${endDate.slice(5, 7)}/${endDate.slice(8, 10)}/${endDate.slice(0, 4)}`
        : "";

      const res = await fetch("/api/admin/itcm/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType,
          authorizerKey: authorizer,
          personIds: [...selectedPeopleIds],
          endDate: endDateFormatted,
        }),
      });

      if (!res.ok) {
        const { error: msg } = await res.json();
        throw new Error(msg ?? "Generation failed");
      }

      const data = await res.json();

      // Trigger PDF download.
      const pdfBlob = base64ToBlob(data.pdfBase64, "application/pdf");
      triggerDownload(pdfBlob, data.pdfFilename);

      // Trigger spreadsheet download if present (bulk only).
      if (data.xlsxBase64) {
        const xlBlob = base64ToBlob(
          data.xlsxBase64,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        triggerDownload(xlBlob, data.xlsxFilename);
      }

      // Build email draft from returned data.
      const subject = EMAIL_SUBJECTS[requestType](authorizer, todayMMDDYYYY());
      setEmailDraft({ subject, body: data.emailBody });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* ── Step 1: Configuration ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <h2 className="text-base font-semibold text-slate-800">1. Configure request</h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Authorizer">
            <Select
              value={authorizer}
              onChange={(e) => setAuthorizer(e.target.value as AuthorizerKey)}
            >
              {(Object.entries(AUTHORIZERS) as [AuthorizerKey, typeof AUTHORIZERS[AuthorizerKey]][]).map(
                ([key, val]) => (
                  <option key={key} value={key}>
                    {val.name}
                  </option>
                )
              )}
            </Select>
          </Field>

          <Field label="Request type">
            <Select
              value={requestType.startsWith("bulk") ? requestType.replace("bulk_", "") : requestType.replace("_individual", "")}
              onChange={(e) => {
                const base = e.target.value as "new" | "mod" | "renew";
                const raw = isBulk ? `bulk_${base}` : `${base}_individual`;
                const safe = raw === "bulk_renew" ? "bulk_mod" : raw;
                setRequestType(safe as RequestType);
                setSelectedPeopleIds(new Set());
              }}
            >
              <option value="new">New</option>
              <option value="mod">Modify</option>
              {!isBulk && <option value="renew">Renew</option>}
            </Select>
          </Field>

          <Field label="Scope">
            <Select
              value={isBulk ? "bulk" : "individual"}
              onChange={(e) => {
                const bulk = e.target.value === "bulk";
                const base = requestType.replace("_individual", "").replace("bulk_", "");
                const raw = bulk ? `bulk_${base}` : `${base}_individual`;
                const safe = raw === "bulk_renew" ? "bulk_mod" : raw;
                setRequestType(safe as RequestType);
                setSelectedPeopleIds(new Set());
              }}
            >
              <option value="individual">Individual</option>
              <option value="bulk">Bulk</option>
            </Select>
          </Field>

          {!isNew && (
            <Field label="Access end date">
              <Input
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
          Authorizer: <span className="font-medium text-slate-800">{AUTHORIZERS[authorizer].name}</span>
          {" · "}
          {AUTHORIZERS[authorizer].phone}
          {" · "}
          {AUTHORIZERS[authorizer].email}
        </div>
      </section>

      {/* ── Step 2: Person selection ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <h2 className="text-base font-semibold text-slate-800">
          2. Select {isBulk ? "people" : "person"}
        </h2>

        <Field label="Department">
          <Select
            value={selectedDeptId}
            onChange={(e) => {
              setSelectedDeptId(e.target.value);
              setSelectedPeopleIds(new Set());
            }}
          >
            <option value="">— choose a department —</option>
            {departments.map((d) => (
              <option key={d.department.id} value={d.department.id}>
                {d.department.code} — {d.department.name}
              </option>
            ))}
          </Select>
        </Field>

        {selectedDept && (
          <div className="space-y-4">
            {/* Directors */}
            {selectedDept.directors.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                  Directors
                </p>
                <div className="space-y-1">
                  {selectedDept.directors.map((p) => (
                    <PersonRow
                      key={p.id}
                      person={p}
                      selected={selectedPeopleIds.has(p.id)}
                      onToggle={() => togglePerson(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Volunteers */}
            {selectedDept.volunteers.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                  Volunteers
                </p>
                <div className="space-y-1">
                  {selectedDept.volunteers.map((p) => (
                    <PersonRow
                      key={p.id}
                      person={p}
                      selected={selectedPeopleIds.has(p.id)}
                      onToggle={() => togglePerson(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {allMembers.length === 0 && (
              <p className="text-sm text-slate-500">No active members in this department.</p>
            )}
          </div>
        )}

        {selectedPeopleIds.size > 0 && (
          <p className="text-sm text-slate-600">
            {selectedPeopleIds.size} {selectedPeopleIds.size === 1 ? "person" : "people"} selected
          </p>
        )}
      </section>

      {/* ── Step 3: Generate ── */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <h2 className="text-base font-semibold text-slate-800">3. Generate</h2>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={loading || selectedPeopleIds.size === 0}
        >
          {loading ? "Generating…" : "Generate PDF" + (isBulk ? " + spreadsheet" : "")}
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          Note: after downloading, open the PDF, then use File → Print → Save as PDF before emailing it to YNHH. This ensures the filled fields display correctly on their end.
        </p>
        </Button>

        {emailDraft && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-700">Email draft</p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
              <div className="text-xs text-slate-500 font-medium">
                To: <span className="text-slate-700">helpdesk@ynhh.org</span>
              </div>
              <div className="text-xs text-slate-500 font-medium">
                Subject: <span className="text-slate-700">{emailDraft.subject}</span>
              </div>
              <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans mt-3 leading-relaxed">
                {emailDraft.body}
              </pre>
            </div>
            <Button
              variant="outline"
              onClick={() => navigator.clipboard?.writeText(
                `To: helpdesk@ynhh.org\nSubject: ${emailDraft.subject}\n\n${emailDraft.body}`
              )}
            >
              Copy email
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PersonRow sub-component
// ---------------------------------------------------------------------------

function PersonRow({
  person,
  selected,
  onToggle,
}: {
  person: MemberLite;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50 cursor-pointer">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 rounded accent-brand"
      />
      <span className="text-sm text-slate-800">{person.name}</span>
      {person.netId && (
        <span className="text-xs text-slate-400">{person.netId}</span>
      )}
      {person.epicId ? (
        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
          Epic: {person.epicId}
        </span>
      ) : (
        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
          No Epic ID
        </span>
      )}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}