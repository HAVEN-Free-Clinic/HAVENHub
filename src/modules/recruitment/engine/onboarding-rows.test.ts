import { describe, it, expect } from "vitest";
import {
  deriveRowState, isEligible, isSelectable, filterRows, countEligible,
  type OnboardingRow,
} from "./onboarding-rows";

const NOW = new Date("2026-08-07T12:00:00Z");

function row(over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    acceptanceId: "a1", contractId: "c1", firstName: "Ona", lastName: "Boarder",
    departmentCode: "SRHD", state: "SUBMITTED", onRoster: false, customAnswers: [],
    ...over,
  };
}

describe("deriveRowState", () => {
  it("reports a conflicted acceptance as CONFLICT regardless of contract state", () => {
    const contract = { status: "SUBMITTED", expiresAt: null };
    expect(deriveRowState({ conflicted: true, contract, now: NOW })).toBe("CONFLICT");
  });

  it("reports a missing contract as NO_CONTRACT", () => {
    expect(deriveRowState({ conflicted: false, contract: null, now: NOW })).toBe("NO_CONTRACT");
  });

  it("reports a live PENDING contract as SENT", () => {
    const contract = { status: "PENDING", expiresAt: new Date("2026-08-20T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SENT");
  });

  it("reports a lapsed PENDING contract as EXPIRED", () => {
    const contract = { status: "PENDING", expiresAt: new Date("2026-08-01T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("EXPIRED");
  });

  // Contracts created before expiresAt existed are grandfathered as non-expiring,
  // matching isContractExpired in the service.
  it("treats a null expiry as non-expiring", () => {
    const contract = { status: "PENDING", expiresAt: null };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SENT");
  });

  it("passes SUBMITTED and PROMOTED through", () => {
    expect(deriveRowState({ conflicted: false, contract: { status: "SUBMITTED", expiresAt: null }, now: NOW })).toBe("SUBMITTED");
    expect(deriveRowState({ conflicted: false, contract: { status: "PROMOTED", expiresAt: null }, now: NOW })).toBe("PROMOTED");
  });

  // An expired link that the applicant already submitted is not stale; expiry
  // only gates the PENDING window.
  it("ignores expiry once the contract is submitted", () => {
    const contract = { status: "SUBMITTED", expiresAt: new Date("2026-08-01T12:00:00Z") };
    expect(deriveRowState({ conflicted: false, contract, now: NOW })).toBe("SUBMITTED");
  });
});

describe("isEligible", () => {
  it("allows send for states with no live submitted contract", () => {
    expect(isEligible("send", "NO_CONTRACT")).toBe(true);
    expect(isEligible("send", "SENT")).toBe(true);
    expect(isEligible("send", "EXPIRED")).toBe(true);
    expect(isEligible("send", "SUBMITTED")).toBe(false);
    expect(isEligible("send", "PROMOTED")).toBe(false);
    expect(isEligible("send", "CONFLICT")).toBe(false);
  });

  it("allows promote only for SUBMITTED", () => {
    expect(isEligible("promote", "SUBMITTED")).toBe(true);
    expect(isEligible("promote", "SENT")).toBe(false);
    expect(isEligible("promote", "NO_CONTRACT")).toBe(false);
    expect(isEligible("promote", "CONFLICT")).toBe(false);
  });

  it("allows withdraw wherever a non-promoted contract exists", () => {
    expect(isEligible("withdraw", "SENT")).toBe(true);
    expect(isEligible("withdraw", "EXPIRED")).toBe(true);
    expect(isEligible("withdraw", "SUBMITTED")).toBe(true);
    expect(isEligible("withdraw", "NO_CONTRACT")).toBe(false);
    expect(isEligible("withdraw", "PROMOTED")).toBe(false);
  });
});

describe("isSelectable", () => {
  it("excludes rows no action can touch", () => {
    expect(isSelectable("CONFLICT")).toBe(false);
    expect(isSelectable("PROMOTED")).toBe(false);
  });

  it("includes every row at least one action can touch", () => {
    for (const s of ["NO_CONTRACT", "SENT", "EXPIRED", "SUBMITTED"] as const) {
      expect(isSelectable(s)).toBe(true);
    }
  });
});

describe("filterRows", () => {
  const rows = [
    row({ acceptanceId: "a1", firstName: "Ona", lastName: "Boarder", departmentCode: "SRHD", state: "SUBMITTED" }),
    row({ acceptanceId: "a2", firstName: "Ray", lastName: "Chen", departmentCode: "PCAR", state: "EXPIRED" }),
    row({ acceptanceId: "a3", firstName: "Sam", lastName: "Ortiz", departmentCode: "SRHD", state: "CONFLICT" }),
  ];
  const all = { query: "", status: "ALL", dept: "ALL" } as const;

  it("returns everything by default", () => {
    expect(filterRows(rows, all)).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(filterRows(rows, { ...all, status: "EXPIRED" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
  });

  it("filters by department", () => {
    expect(filterRows(rows, { ...all, dept: "SRHD" }).map((r) => r.acceptanceId)).toEqual(["a1", "a3"]);
  });

  it("searches first and last name case-insensitively", () => {
    expect(filterRows(rows, { ...all, query: "chen" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
    expect(filterRows(rows, { ...all, query: "ONA" }).map((r) => r.acceptanceId)).toEqual(["a1"]);
  });

  it("matches across the full name", () => {
    expect(filterRows(rows, { ...all, query: "ray c" }).map((r) => r.acceptanceId)).toEqual(["a2"]);
  });

  it("combines filters", () => {
    expect(filterRows(rows, { query: "", status: "SUBMITTED", dept: "PCAR" })).toEqual([]);
  });
});

describe("countEligible", () => {
  it("counts only rows the action can act on", () => {
    const rows = [
      row({ state: "SUBMITTED" }), row({ state: "SUBMITTED" }),
      row({ state: "EXPIRED" }), row({ state: "CONFLICT" }),
    ];
    expect(countEligible(rows, "promote")).toBe(2);
    expect(countEligible(rows, "send")).toBe(1);
    expect(countEligible(rows, "withdraw")).toBe(3);
  });
});
