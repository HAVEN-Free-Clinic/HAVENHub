import { createElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { ServiceRecord } from "../services/service-record";
import { PassportDocument, formatShifts } from "./passport-pdf";

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
  capabilities: { spanishVerified: true, licensedRN: false },
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
  if (typeof node === "object" && node !== null && "props" in node) {
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
      capabilities: { spanishVerified: false, licensedRN: false },
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
      capabilities: { spanishVerified: false, licensedRN: false },
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
