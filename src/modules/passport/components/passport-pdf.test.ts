import { createElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import {
  formatShifts,
  formatHours,
  formatServiceDates,
  formatShiftsAndHours,
  type ServiceRecord,
} from "../services/service-record";
import { PassportDocument } from "./passport-pdf";

const RECORD: ServiceRecord = {
  name: "Ada Lovelace",
  memberSince: { label: "Fall 2023 Volunteer Recruitment", source: "RECRUITMENT" },
  terms: [
    {
      termCode: "FA23",
      termName: "Fall 2023 Volunteer Recruitment",
      startDate: "2023-09-15T12:00:00.000Z",
      departmentName: "Internal Medicine",
      track: "VOLUNTEER",
      shifts: null,
      source: "RECRUITMENT",
    },
    {
      termCode: "SU26",
      termName: "Summer 2026",
      startDate: "2026-05-01T12:00:00.000Z",
      departmentName: "Internal Medicine",
      track: "DIRECTOR",
      shifts: 14,
      source: "MEMBERSHIP",
    },
  ],
  capabilities: { verifiedLanguages: ["es"], licensedRN: false },
  basis: "SCHEDULED",
  generatedAt: "2026-08-07T12:00:00.000Z",
};

/**
 * Walks a React element tree (as returned by calling a function component
 * directly, without rendering it) and collects every string/number leaf out
 * of `props.children`. This lets the tests assert on document CONTENT, not
 * just "it produced PDF bytes without throwing" -- the smoke tests below
 * cannot see a silently-dropped value (e.g. a deleted `credentialUrl`
 * interpolation would still render a valid, non-empty PDF).
 */
function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) {
    const children = (node as { props?: { children?: unknown } }).props?.children;
    return textOf(children);
  }
  return "";
}

describe("formatShifts", () => {
  it("renders a real count", () => {
    expect(formatShifts(14)).toBe("14 scheduled");
  });

  it("renders zero as an explicit zero, not as missing data", () => {
    expect(formatShifts(0)).toBe("0 scheduled");
  });

  it("renders missing shift data as a dash, never as zero", () => {
    expect(formatShifts(null)).toBe("Not recorded");
  });
});

describe("formatHours", () => {
  it("drops the decimal on a whole number", () => {
    expect(formatHours(18)).toBe("18 hours");
  });

  it("keeps one decimal on a half hour", () => {
    expect(formatHours(16.5)).toBe("16.5 hours");
  });

  // null is a department with no configured shift length; undefined is a
  // credential snapshot issued before hours existed. Neither is a claim about
  // how long the member served, so both read the same.
  it("reads unconfigured and pre-existing snapshots identically", () => {
    expect(formatHours(null)).toBe("Not recorded");
    expect(formatHours(undefined)).toBe("Not recorded");
  });
});

describe("formatServiceDates", () => {
  it("renders month and day, the year coming from the term", () => {
    expect(formatServiceDates(["2026-06-03", "2026-06-10"])).toBe("Jun 3, Jun 10");
  });

  // The dates are noon-UTC calendar markers. A local-time parse would render
  // Jun 3 as Jun 2 in every US zone, putting the credential a day out from the
  // schedule it was built from.
  it("does not shift dates backwards out of UTC", () => {
    expect(formatServiceDates(["2026-01-01"])).toBe("Jan 1");
  });

  it("renders nothing when unknown or empty, so the line is simply omitted", () => {
    expect(formatServiceDates(null)).toBe("");
    expect(formatServiceDates(undefined)).toBe("");
    expect(formatServiceDates([])).toBe("");
  });
});

describe("formatShiftsAndHours", () => {
  it("appends hours when both are known", () => {
    expect(formatShiftsAndHours(3, 18)).toBe("3 scheduled, 18 hours");
  });

  // A department with no configured shift length must read exactly as it did
  // before hours existed, rather than gaining a "Not recorded" suffix.
  it("falls back to shifts alone when hours are unknown", () => {
    expect(formatShiftsAndHours(3, null)).toBe("3 scheduled");
    expect(formatShiftsAndHours(3, undefined)).toBe("3 scheduled");
  });

  it("keeps the not-recorded shift case intact", () => {
    expect(formatShiftsAndHours(null, null)).toBe("Not recorded");
  });
});

describe("PassportDocument", () => {
  it("renders to a PDF buffer", async () => {
    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders with a credential URL without throwing", async () => {
    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: "https://hub.example.org/credential/abc",
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it("renders an empty record without throwing", async () => {
    const empty: ServiceRecord = {
      name: "New Member",
      memberSince: null,
      terms: [],
      capabilities: { verifiedLanguages: [], licensedRN: false },
      basis: "SCHEDULED",
      generatedAt: "2026-08-07T12:00:00.000Z",
    };

    const buffer = await renderToBuffer(
      createElement(PassportDocument, {
        record: empty,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }) as ReactElement<DocumentProps>,
    );

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("PassportDocument content", () => {
  it("renders the member's name and the term rows, distinguishing missing shift data from a real count", () => {
    const text = textOf(
      PassportDocument({
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }),
    );

    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("14 scheduled");
    expect(text).toContain("Not recorded");
    expect(text).toContain("Joined via recruitment");
  });

  it("includes the credential URL when one is provided", () => {
    const text = textOf(
      PassportDocument({
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: "https://hub.example.org/credential/abc",
      }),
    );

    expect(text).toContain("https://hub.example.org/credential/abc");
  });

  it("omits the credential URL and the verify line when none is provided", () => {
    const text = textOf(
      PassportDocument({
        record: RECORD,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }),
    );

    expect(text).not.toContain("https://hub.example.org/credential/abc");
    expect(text).not.toContain("Verify");
  });

  it("renders 0 scheduled and Not recorded as distinct values in the same document", () => {
    const mixed: ServiceRecord = {
      name: "Test Member",
      memberSince: null,
      terms: [
        {
          termCode: "FA23",
          termName: "Fall 2023",
          startDate: "2023-09-15T12:00:00.000Z",
          departmentName: "Internal Medicine",
          track: "VOLUNTEER",
          shifts: null,
          source: "RECRUITMENT",
        },
        {
          termCode: "SP24",
          termName: "Spring 2024",
          startDate: "2024-01-15T12:00:00.000Z",
          departmentName: "Internal Medicine",
          track: "VOLUNTEER",
          shifts: 0,
          source: "MEMBERSHIP",
        },
      ],
      capabilities: { verifiedLanguages: [], licensedRN: false },
      basis: "SCHEDULED",
      generatedAt: "2026-08-07T12:00:00.000Z",
    };

    const text = textOf(
      PassportDocument({
        record: mixed,
        orgName: "HAVEN Free Clinic",
        brandColor: "#00356b",
        credentialUrl: null,
      }),
    );

    expect(text).toContain("0 scheduled");
    expect(text).toContain("Not recorded");
  });
});
