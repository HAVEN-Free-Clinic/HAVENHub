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
import type { DepartmentWithMembers, EpicAuthorizer, MemberLite, PendingDeactivation } from "@/modules/admin/services/itcm";
import { Button } from "@/platform/ui/button";
import { Select } from "@/platform/ui/select";
import { Input, Field } from "@/platform/ui/input";
import { Card } from "@/platform/ui/card";
import { Alert } from "@/platform/ui/alert";
import { Badge } from "@/platform/ui/badge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type RequestType =
  | "new_individual"
  | "mod_individual"
  | "renew_individual"
  | "bulk_new"
  | "bulk_mod"
  | "deactivate_individual"
  | "bulk_deactivate";


const EMAIL_SUBJECTS: Record<RequestType, (initials: string, date: string) => string> = {
  new_individual: (i, d) => `[HAVEN] New Epic Account Request ${i} ${d}`,
  mod_individual: (i, d) => `[HAVEN] Modify Epic Access for One User ${d} ${i}`,
  renew_individual: (i, d) => `[HAVEN] Renew Epic Access for One User ${d} ${i}`,
  bulk_mod: (i, d) => `[HAVEN] Reactivate/Extend and Modify Epic Access for Multiple Users ${d} ${i}`,
  bulk_new: (i, d) => `[HAVEN] Multiple New Epic Account Request ${d} ${i}`,
  deactivate_individual: (i, d) => `[HAVEN] Deactivate Epic Access for One User ${d} ${i}`,
  bulk_deactivate: (i, d) => `[HAVEN] Deactivate Epic Access for Multiple Users ${d} ${i}`,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  departments: DepartmentWithMembers[];
  pendingDeactivations: PendingDeactivation[];
  /** Current term's ITCM directors, the people who can authorize a request. */
  authorizers: EpicAuthorizer[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EpicRequestForm({ departments, pendingDeactivations, authorizers }: Props) {
  // Step 1: configuration. The authorizer is identified by person id; default
  // to the first ITCM director (empty string when there are none).
  const [authorizerId, setAuthorizerId] = useState<string>(authorizers[0]?.id ?? "");
  const [requestType, setRequestType] = useState<RequestType>("new_individual");
  const [endDate, setEndDate] = useState("");

  const selectedAuthorizer = useMemo(
    () => authorizers.find((a) => a.id === authorizerId) ?? null,
    [authorizers, authorizerId]
  );

  // Step 2: person selection. For bulk requests, selections persist across
  // department switches so people from multiple departments can be picked together.
  const [selectedDeptId, setSelectedDeptId] = useState<string>("");
  const [selectedPeopleIds, setSelectedPeopleIds] = useState<Set<string>>(new Set());
  const [selectedPeopleMap, setSelectedPeopleMap] = useState<Map<string, MemberLite>>(new Map());

  // Step 3: results
  const [loading, setLoading] = useState(false);
  const [emailDraft, setEmailDraft] = useState<{ subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBulk = requestType.startsWith("bulk");
  const isNew = requestType.includes("new");
  const isDeactivate = requestType.startsWith("deactivate") || requestType === "bulk_deactivate";

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

  function togglePerson(id: string, person: MemberLite) {
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
    setSelectedPeopleMap((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (!isBulk) next.clear();
        next.set(id, person);
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
    if (!selectedAuthorizer) {
      setError("No ITCM director is available to authorize this request.");
      return;
    }
    if (selectedPeopleIds.size === 0) {
      setError("Select at least one person before generating.");
      return;
    }
    if (!endDate) {
      setError("Set the access end date before generating this request.");
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
          authorizerId: selectedAuthorizer.id,
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

      // Build email draft from returned data. The subject carries the
      // authorizer's initials, derived from their name on the server.
      const subject = EMAIL_SUBJECTS[requestType](selectedAuthorizer.initials, todayMMDDYYYY());
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
      <Card pad={false} className="p-6 space-y-5">
        <h2 className="text-base font-semibold text-foreground">1. Configure request</h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Authorizer">
            <Select
              value={authorizerId}
              onChange={(e) => setAuthorizerId(e.target.value)}
              disabled={authorizers.length === 0}
            >
              {authorizers.length === 0 ? (
                <option value="">No ITCM directors</option>
              ) : (
                authorizers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              )}
            </Select>
          </Field>

          <Field label="Request type">
            <Select
              value={requestType.startsWith("bulk") ? requestType.replace("bulk_", "") : requestType.replace("_individual", "")}
              onChange={(e) => {
                const base = e.target.value as "new" | "mod" | "renew" | "deactivate";
                const raw = isBulk ? `bulk_${base}` : `${base}_individual`;
                const safe = raw === "bulk_renew" ? "bulk_mod" : raw;
                setRequestType(safe as RequestType);
                setSelectedPeopleIds(new Set());
                setSelectedPeopleMap(new Map());
              }}
            >
              <option value="new">New</option>
              <option value="mod">Modify</option>
              {!isBulk && <option value="renew">Renew</option>}
              <option value="deactivate">Deactivate</option>
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
                setSelectedPeopleMap(new Map());
              }}
            >
              <option value="individual">Individual</option>
              <option value="bulk">Bulk</option>
            </Select>
          </Field>

          
            <Field label="Access end date">
            <Input
              type="date"
              required
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
    
        </div>

        {selectedAuthorizer ? (
          <Alert tone="info">
            Authorizer: <span className="font-medium">{selectedAuthorizer.name}</span>
            {selectedAuthorizer.phone && (
              <>
                {" · "}
                {selectedAuthorizer.phone}
              </>
            )}
            {selectedAuthorizer.email && (
              <>
                {" · "}
                {selectedAuthorizer.email}
              </>
            )}
          </Alert>
        ) : (
          <Alert tone="warning">
            No ITCM directors are set for the current term, so there is no one to authorize this
            request. Add an ITCM director to the active term and they will appear here.
          </Alert>
        )}
      </Card>

      {/* ── Step 2: Person selection ── */}
      <Card pad={false} className="p-6 space-y-5">
        <h2 className="text-base font-semibold text-foreground">
          2. Select {isBulk ? "people" : "person"}
        </h2>

        {isDeactivate ? (
          <div className="space-y-1">
            {pendingDeactivations.length === 0 && (
              <p className="text-sm text-muted-foreground">No people are awaiting Epic deactivation.</p>
            )}
            {pendingDeactivations.map((p) => (
              <PersonRow
                key={p.id}
                person={{ id: p.id, name: p.name, netId: p.netId, contactEmail: p.contactEmail, epicId: p.epicId, kind: "VOLUNTEER" }}
                selected={selectedPeopleIds.has(p.id)}
                onToggle={() => togglePerson(p.id, { id: p.id, name: p.name, netId: p.netId, contactEmail: p.contactEmail, epicId: p.epicId, kind: "VOLUNTEER" })}
              />
            ))}
          </div>
        ) : isBulk ? (
          <div className="space-y-6">
            {departments.map((d) => (
              <div key={d.department.id} className="space-y-3">
                <p className="text-sm font-semibold text-foreground">
                  {d.department.code} — {d.department.name}
                </p>
                {d.directors.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Directors
                    </p>
                    <div className="space-y-1">
                      {d.directors.map((p) => (
                        <PersonRow
                          key={p.id}
                          person={p}
                          selected={selectedPeopleIds.has(p.id)}
                          onToggle={() => togglePerson(p.id, p)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {d.volunteers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Volunteers
                    </p>
                    <div className="space-y-1">
                      {d.volunteers.map((p) => (
                        <PersonRow
                          key={p.id}
                          person={p}
                          selected={selectedPeopleIds.has(p.id)}
                          onToggle={() => togglePerson(p.id, p)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {d.directors.length === 0 && d.volunteers.length === 0 && (
                  <p className="text-sm text-muted-foreground">No active members in this department.</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            <Field label="Department">
              <Select
                value={selectedDeptId}
                onChange={(e) => {
                  setSelectedDeptId(e.target.value);
                  setSelectedPeopleIds(new Set());
                  setSelectedPeopleMap(new Map());
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
                {selectedDept.directors.length > 0 && (
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Directors
                    </p>
                    <div className="space-y-1">
                      {selectedDept.directors.map((p) => (
                        <PersonRow
                          key={p.id}
                          person={p}
                          selected={selectedPeopleIds.has(p.id)}
                          onToggle={() => togglePerson(p.id, p)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {selectedDept.volunteers.length > 0 && (
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Volunteers
                    </p>
                    <div className="space-y-1">
                      {selectedDept.volunteers.map((p) => (
                        <PersonRow
                          key={p.id}
                          person={p}
                          selected={selectedPeopleIds.has(p.id)}
                          onToggle={() => togglePerson(p.id, p)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {allMembers.length === 0 && (
                  <p className="text-sm text-muted-foreground">No active members in this department.</p>
                )}
              </div>
            )}
          </>
        )}

        {selectedPeopleIds.size > 0 && (
          <p className="text-sm text-foreground-soft">
            {selectedPeopleIds.size} {selectedPeopleIds.size === 1 ? "person" : "people"} selected
          </p>
        )}

        {isBulk && selectedPeopleMap.size > 0 && (
          <div className="rounded-xl border border-border bg-muted p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Selected across all departments
            </p>
            <div className="space-y-1">
              {[...selectedPeopleMap.values()].map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground">{p.name}</span>
                  <button
                    type="button"
                    onClick={() => togglePerson(p.id, p)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ── Step 3: Generate ── */}
      <Card pad={false} className="p-6 space-y-5">
        <h2 className="text-base font-semibold text-foreground">3. Generate</h2>

        {error && <Alert tone="error">{error}</Alert>}

        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={loading || selectedPeopleIds.size === 0 || !selectedAuthorizer}
        >
          {loading ? "Generating…" : "Generate PDF" + (isBulk ? " + spreadsheet" : "")}
        </Button>

        {emailDraft && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-foreground-soft">Email draft</p>
            <div className="rounded-xl border border-border bg-muted p-4 space-y-2">
              <div className="text-xs text-muted-foreground font-medium">
                To: <span className="text-foreground-soft">helpdesk@ynhh.org</span>
              </div>
              <div className="text-xs text-muted-foreground font-medium">
                Subject: <span className="text-foreground-soft">{emailDraft.subject}</span>
              </div>
              <pre className="text-sm text-foreground-soft whitespace-pre-wrap font-sans mt-3 leading-relaxed">
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
      </Card>
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
    <label className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted cursor-pointer">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="h-4 w-4 rounded accent-brand"
      />
      <span className="text-sm text-foreground">{person.name}</span>
      {person.netId && (
        <span className="text-xs text-subtle-foreground">{person.netId}</span>
      )}
      {person.epicId ? (
        <Badge tone="success">Epic: {person.epicId}</Badge>
      ) : (
        <Badge tone="warning">No Epic ID</Badge>
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