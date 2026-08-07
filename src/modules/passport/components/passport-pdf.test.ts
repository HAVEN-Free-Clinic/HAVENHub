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
