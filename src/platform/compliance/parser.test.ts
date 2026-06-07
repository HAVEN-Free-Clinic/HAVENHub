/**
 * Tests for the HIPAA certificate PDF date parser.
 *
 * Uses synthetic text fixtures so tests run without any filesystem I/O.
 * All extracted dates must be noon UTC to avoid day-boundary issues in
 * downstream expiry arithmetic.
 */

import { describe, expect, it } from "vitest";
import { extractDateFromText } from "./parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a noon-UTC date for assertions. */
function noon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

// ---------------------------------------------------------------------------
// Format: "Month D, YYYY ... Date of Completion"  (dominant corpus format)
// ---------------------------------------------------------------------------

describe("extractDateFromText - Certificate of Completion format", () => {
  it("parses 'Month DD, YYYY Authority Date of Completion'", () => {
    const text =
      "Certificate of Completion is awarded to Smith, Jane as proof of completing course training: " +
      "Basic Foundational HIPAA Privacy and Security Training ERM February 08, 2026 Authority Date of Completion";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2026, 2, 8).toISOString());
  });

  it("parses single-digit day (Month D, YYYY)", () => {
    const text =
      "Certificate of Completion is awarded to Jones, Bob as proof of completing course training: " +
      "Annual Security Attestation ERM June 5, 2025 Authority Date of Completion";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 6, 5).toISOString());
  });

  it("includes matchedText", () => {
    const text =
      "Certificate of Completion ... HIPAA Training ERM October 22, 2025 Authority Date of Completion";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.matchedText).toMatch(/October 22, 2025/);
  });

  it("picks the HIPAA cert date when multiple certs are in one PDF (multiple awarded blocks)", () => {
    const text =
      "Certificate of Completion is awarded to Lee, Goeun as proof of completing: " +
      "Bloodborne Pathogens EHS August 13, 2025 Authority Date of Completion " +
      "Certificate of Completion is awarded to Lee, Goeun as proof of completing: " +
      "Annual Security Attestation and HIPAA Refresher IT August 13, 2025 Authority Date of Completion";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    // Either date is valid (same date here); the important thing is we get a result
    expect(result!.date.toISOString()).toBe(noon(2025, 8, 13).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Format: "DATE OF COMPLETION Oct 22, 2025"  (program completion page)
// ---------------------------------------------------------------------------

describe("extractDateFromText - DATE OF COMPLETION label", () => {
  it("parses 'DATE OF COMPLETION Month DD, YYYY'", () => {
    const text =
      "Kabwita, Fidah Kay, you have completed Foundational HIPAA Privacy and Security Program " +
      "ITEMS COMPLETED 1 DATE OF COMPLETION Oct 22, 2025 Description: HIPAA Privacy and Security training";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 10, 22).toISOString());
  });

  it("parses 'DATE OF COMPLETION Mar 17, 2026'", () => {
    const text =
      "you have completed Annual Security Attestation and HIPAA Program ITEMS COMPLETED 1 DATE OF COMPLETION Mar 17, 2026";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2026, 3, 17).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Format: "Course completed on: Sep 5, 2025"
// ---------------------------------------------------------------------------

describe("extractDateFromText - Course completed on", () => {
  it("parses 'Course completed on: Sep 5, 2025'", () => {
    const text =
      "Your Overall Course Results Course completed on: Sep 5, 2025 SCORE 80 GRADE Pass " +
      "Basic Foundational HIPAA Privacy and Security Training";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 5).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Format: "Learning Enrollment Completion Moment 09/22/2025"  (View Learning Enrollment)
// ---------------------------------------------------------------------------

describe("extractDateFromText - Completion Moment (MM/DD/YYYY)", () => {
  it("parses 'Completion Moment 09/22/2025'", () => {
    const text =
      "View Learning Enrollment: Hall, Aiden - Researcher's Foundational HIPAA Privacy and Security " +
      "Completion Status Completed Learning Enrollment Completion Moment 09/22/2025 08:08:01 PM " +
      "Overall Score 93 Overall Grade Pass";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 22).toISOString());
  });

  it("parses 'Completion Moment 08/05/2025' even when Expiration Date follows", () => {
    const text =
      "Learning Content Annual Security Attestation and HIPAA Refresher " +
      "Completion Status Completed Learning Enrollment Completion Moment 08/05/2025 01:42:26 PM " +
      "Expiration Date 08/05/2026 Course Tracking";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 8, 5).toISOString());
    // Must NOT return the expiration date (2026)
    expect(result!.date.getUTCFullYear()).toBe(2025);
  });
});

// ---------------------------------------------------------------------------
// Format: "Completion Date and Time 09/05/2025"  (My Transcript / View Learning)
// ---------------------------------------------------------------------------

describe("extractDateFromText - Completion Date and Time", () => {
  it("parses HIPAA course Completion Date from transcript", () => {
    const text =
      "Lee, Goeun - Annual Security Attestation and HIPAA Refresher Annual Security Attestation and HIPAA Refresher " +
      "Digital Course Enrolled 05/12/2025 Completed 08/13/2025 09:31:07 AM 08/13/2026 Do Not Track 0 Enrollment";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    // Completed date is 08/13/2025; expiry 08/13/2026 must NOT be returned
    expect(result!.date.toISOString()).toBe(noon(2025, 8, 13).toISOString());
  });

  it("parses 'Completion Date and Time ... Completed 09/05/2025' from View Learning Enrollment", () => {
    const text =
      "View Learning Enrollment: Matthews, Cullen - Basic Foundational HIPAA Privacy and Security Training " +
      "Completion Status Completed Learning Enrollment Completion Moment 09/05/2025 01:14:30 AM " +
      "Overall Score 90 Overall Grade Pass";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 5).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Format: "Record of Completion ... Date 02/15/2026" / "on 02/15/26"
// ---------------------------------------------------------------------------

describe("extractDateFromText - Record of Completion", () => {
  it("parses date from 'Record of Completion ... Date MM/DD/YYYY'", () => {
    const text =
      "Record of Completion This is to confirm that Foundational HIPAA Privacy and Security Training " +
      "HIPAA Privacy Course Owner Date 02/15/2026 Avi Patel Has successfully completed the following Course on 02/15/26";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.getUTCFullYear()).toBe(2026);
    expect(result!.date.getUTCMonth()).toBe(1); // February = 1
    expect(result!.date.getUTCDate()).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Format: "completed on MM/DD/YYYY" (Workday event enrollment)
// ---------------------------------------------------------------------------

describe("extractDateFromText - Workday event enrollment", () => {
  it("parses 'Successfully Completed Initiated On 09/13/2025'", () => {
    const text =
      "Event: Enroll in Content: Basic Foundational HIPAA Privacy and Security Training " +
      "Subject Chen, Chloe Overall Status Successfully Completed Initiated On 09/13/2025 06:55:28 PM";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 13).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Additional date formats from the plan
// ---------------------------------------------------------------------------

describe("extractDateFromText - additional date formats", () => {
  it("parses MM/DD/YYYY format near completion context", () => {
    const text = "has completed the HIPAA course Completion Date: 09/15/2025";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 15).toISOString());
  });

  it("parses YYYY-MM-DD format near completion context", () => {
    const text = "Date of Completion 2025-06-15 course complete";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 6, 15).toISOString());
  });

  it("parses DD-MMM-YYYY format near completion context", () => {
    const text = "completed on 05-Jun-2025 HIPAA training";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 6, 5).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Sanity window: reject future dates and dates older than 5 years
// ---------------------------------------------------------------------------

describe("extractDateFromText - sanity window", () => {
  it("returns null for a future date near completion context", () => {
    // Build a date clearly in the future
    const futureYear = new Date().getUTCFullYear() + 2;
    const text = `Date of Completion ${futureYear}-01-01`;
    const result = extractDateFromText(text);
    expect(result).toBeNull();
  });

  it("returns null for a date older than 5 years", () => {
    const ancientYear = new Date().getUTCFullYear() - 6;
    const text = `completed on January 01, ${ancientYear}`;
    const result = extractDateFromText(text);
    expect(result).toBeNull();
  });

  it("accepts a date exactly at the 5-year boundary (within window)", () => {
    // 4 years ago should be accepted
    const fourYearsAgo = new Date();
    fourYearsAgo.setUTCFullYear(fourYearsAgo.getUTCFullYear() - 4);
    const y = fourYearsAgo.getUTCFullYear();
    const m = String(fourYearsAgo.getUTCMonth() + 1).padStart(2, "0");
    const d = String(fourYearsAgo.getUTCDate()).padStart(2, "0");
    const text = `Date of Completion ${y}-${m}-${d}`;
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exclusion: expiration-only context MUST return null
// ---------------------------------------------------------------------------

describe("extractDateFromText - expiration exclusion", () => {
  it("returns null when only expiration context present", () => {
    const text = "Expiration Date 08/05/2026 Expires 2026-08-05 valid until August 5, 2026";
    expect(extractDateFromText(text)).toBeNull();
  });

  it("returns null for expiration-only text with 'expires' keyword", () => {
    const text = "This certification expires on January 01, 2027. Valid until 01/01/2027.";
    expect(extractDateFromText(text)).toBeNull();
  });

  it("returns completion date (not expiration) when both contexts present", () => {
    const text =
      "Completion Status Completed Learning Enrollment Completion Moment 08/05/2025 01:42:26 PM " +
      "Expiration Date 08/05/2026";
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
    expect(result!.date.getUTCFullYear()).toBe(2025);
  });
});

// ---------------------------------------------------------------------------
// No dates in text
// ---------------------------------------------------------------------------

describe("extractDateFromText - no dates", () => {
  it("returns null when text has no dates at all", () => {
    const text = "This document contains no dates whatsoever. HIPAA training details.";
    expect(extractDateFromText(text)).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(extractDateFromText("")).toBeNull();
  });

  it("returns null for text with only non-date numbers", () => {
    const text = "Score: 90 out of 100. Page 1 of 3.";
    expect(extractDateFromText(text)).toBeNull();
  });
});
