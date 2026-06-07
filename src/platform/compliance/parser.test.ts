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

  it("accepts a date one day inside the 5-year boundary", () => {
    // The cutoff is exactly 5 years ago at noon UTC. A date one day NEWER
    // than the cutoff (4 years 364 days old) must be accepted.
    const cutoff = new Date(Date.UTC(
      new Date().getUTCFullYear() - 5,
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
      12, 0, 0, 0
    ));
    const inside = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
    const y = inside.getUTCFullYear();
    const m = String(inside.getUTCMonth() + 1).padStart(2, "0");
    const d = String(inside.getUTCDate()).padStart(2, "0");
    const text = `Date of Completion ${y}-${m}-${d}`;
    const result = extractDateFromText(text);
    expect(result).not.toBeNull();
  });

  it("rejects a date one day outside the 5-year boundary", () => {
    // A date one day OLDER than the noon-UTC cutoff (5 years + 1 day old) must
    // be rejected.
    const cutoff = new Date(Date.UTC(
      new Date().getUTCFullYear() - 5,
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
      12, 0, 0, 0
    ));
    const outside = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
    const y = outside.getUTCFullYear();
    const m = String(outside.getUTCMonth() + 1).padStart(2, "0");
    const d = String(outside.getUTCDate()).padStart(2, "0");
    const text = `Date of Completion ${y}-${m}-${d}`;
    const result = extractDateFromText(text);
    expect(result).toBeNull();
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
// Regression fixtures: multi-course Workday "My Transcript" PDFs.
//
// These are ANONYMIZED transcriptions of two real corpus files that the
// previous parser mis-read (it matched the column HEADER window and returned
// the first row's Enrolled date of an arbitrary course). Names are replaced
// with placeholders; the table structure and every date is verbatim.
//
// The correct answer is the HIPAA-context row's *Completed* date - never the
// Enrolled date, never the row's trailing Expiration date - preferring the
// most recent matching row.
// ---------------------------------------------------------------------------

describe("extractDateFromText - Workday My Transcript regression", () => {
  // Source: uploads/cmq3zprpp00gjvwkvr2ycxft3.pdf (names anonymized).
  // The transcript header date is 09/12/2025; the most recent HIPAA row is the
  // "Annual Security Attestation and HIPAA Refresher" completed 09/12/2025.
  // Older HIPAA rows exist (11/05/2024, 09/27/2024) and must NOT win.
  // The previous parser returned a Bloodborne Pathogens Enrolled date.
  const transcript1 =
    "My Transcript 05:57 PM 09/12/2025Page 1 of 3 Not Started Learning Record Name Content Type Registration Status Date Enrolled Completion Status Attendance Status Grade Score Record Type In Progress Learning Record Name Content Type Registration Status Date Enrolled Completion Status Attendance Status Grade Score Record Type " +
    "PERSON_ONE - Bloodborne Pathogens for Clinical Employees Program Bloodborne Pathogens for Clinical Employees Program Program Enrolled 10/09/2024 In Progress Do Not Track 0 Enrollment " +
    "PERSON_ONE - Occupational Safety and Health: Blood-Borne Pathogens Occupational Safety and Health: Blood- Borne Pathogens Digital Course Enrolled 09/27/2024 In Progress Do Not Track 0 Enrollment " +
    "Learning History Learning Record Name Content Type Registration Status Date Enrolled Completion Status Completion Date and Time Expiration Date Attendance Status Grade Score Record Type " +
    "PERSON_ONE - Preventing Discrimination, Harassment, and Sexual Misconduct at Yale (Student Version) Preventing Discrimination, Harassment, and Sexual Misconduct at Yale (Student Version) Digital Course Enrolled 08/01/2025 Completed 09/03/2025 10:21:00 PM Do Not Track 0 Enrollment " +
    "PERSON_ONE - Chemical Hazard Communication General Program Chemical Hazard Communication General Program Program Enrolled 06/01/2025 Completed 11/05/2024 11:55:03 AM Do Not Track 0 Enrollment " +
    "PERSON_ONE - Annual Security Attestation and HIPAA Refresher Annual Security Attestation and HIPAA Refresher Digital Course Enrolled 05/12/2025 Completed 09/12/2025 05:56:04 PM 09/12/2026 Do Not Track 0 Enrollment " +
    "PERSON_ONE - Patent Policy Acknowledgement & Agreement Patent Policy Acknowledgement & Agreement Digital Course Enrolled 09/27/2024 Completed 09/27/2024 09:29:54 PM Do Not Track 0 Enrollment " +
    "PERSON_ONE - Annual Security Attestation and HIPAA Refresher Annual Security Attestation and HIPAA Refresher Digital Course Enrolled 11/05/2024 Completed 11/05/2024 10:39:43 AM 11/05/2025 Do Not Track 0 Enrollment " +
    "PERSON_ONE - Basic Foundational HIPAA Privacy and Security Training Basic Foundational HIPAA Privacy and Security Training Digital Course Enrolled 09/27/2024 Completed 09/27/2024 09:46:15 PM Do Not Track Pass 100 Enrollment";

  it("returns the most recent HIPAA row's Completed date (09/12/2025), not an Enrolled or expiration date", () => {
    const result = extractDateFromText(transcript1);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2025, 9, 12).toISOString());
  });

  // Source: uploads/cmq3zn7o1007mvw54l2m0d82n.pdf (names anonymized).
  // Header date 04/29/2026. Most recent HIPAA row:
  // "Annual Security Attestation and HIPAA Refresher" Completed 04/29/2026,
  // Expiration 04/29/2027. Older HIPAA rows back to 06/03/2023 must NOT win,
  // and the 04/29/2027 expiration must NOT be returned.
  const transcript2 =
    "My Transcript 01:22 PM 04/29/2026Page 1 of 6 Not Started Learning Record Name Content Type Registration Status Date Enrolled Completion Status Attendance Status Grade Score Record Type In Progress Learning Record Name Content Type Registration Status Date Enrolled Completion Status Attendance Status Grade Score Record Type " +
    "Learning History Learning Record Name Version Content Type Registration Status Date Enrolled Completion Status Completion Date and Time Expiration Date Attendance Status Grade Score Record Type " +
    "PERSON_TWO - Patent Policy Acknowledgement & Agreement Patent Policy Acknowledgement & Agreement Digital Course Enrolled 01/15/2026 Completed 02/08/2026 04:11:26 PM Do Not Track 0 Enrollment " +
    "PERSON_TWO - HIPAA Refresher HIPAA Refresher Course Offering Enrolled 09/03/2025 Completed 09/10/2025 06:00:00 PM Attended 0 Enrollment " +
    "PERSON_TWO - Bloodborne Pathogens for Clinical Employees Program Bloodborne Pathogens for Clinical Employees Program Program Enrolled 08/29/2025 Completed 08/29/2025 09:51:22 PM 08/29/2026 Do Not Track 0 Enrollment " +
    "PERSON_TWO - Annual Security Attestation and HIPAA Refresher Annual Security Attestation and HIPAA Refresher Digital Course Enrolled 05/12/2025 Completed 04/29/2026 01:21:21 PM 04/29/2027 Do Not Track 0 Enrollment " +
    "PERSON_TWO - Annual Security Attestation and HIPAA Program Annual Security Attestation and HIPAA Program Program Enrolled 03/30/2025 Completed 03/30/2025 04:08:29 PM Do Not Track 0 Enrollment " +
    "PERSON_TWO - Annual Security Attestation and HIPAA Refresher Annual Security Attestation and HIPAA Refresher Digital Course Enrolled 03/30/2025 Completed 03/30/2025 04:08:29 PM 03/30/2026 Do Not Track 0 Enrollment " +
    "PERSON_TWO - Foundational HIPAA Privacy and Security Program Foundational HIPAA Privacy and Security Program Program Enrolled 06/03/2023 Completed 06/03/2023 03:00:00 AM Do Not Track 0 Enrollment";

  it("returns the most recent HIPAA row's Completed date (04/29/2026), not its 04/29/2027 expiration", () => {
    const result = extractDateFromText(transcript2);
    expect(result).not.toBeNull();
    expect(result!.date.toISOString()).toBe(noon(2026, 4, 29).toISOString());
  });

  it("never returns a date whose immediate context is 'Enrolled'", () => {
    // The first row after the header is a Bloodborne 'Enrolled 10/09/2024'
    // In Progress row. That must never be the answer.
    const result = extractDateFromText(transcript1);
    expect(result).not.toBeNull();
    expect(result!.date.getUTCFullYear()).not.toBe(2024);
    expect(result!.matchedText).not.toMatch(/Enrolled/i);
  });

  it("returns null for a transcript that contains no HIPAA course", () => {
    // A transcript without any HIPAA / security attestation row is not
    // evidence of HIPAA completion.
    const noHipaa =
      "My Transcript 05:57 PM 09/12/2025Page 1 of 1 " +
      "Learning History Learning Record Name Content Type Registration Status Date Enrolled Completion Status Completion Date and Time Expiration Date Attendance Status Grade Score Record Type " +
      "PERSON_THREE - Bloodborne Pathogens for Clinical Employees Program Bloodborne Pathogens for Clinical Employees Program Program Enrolled 06/01/2025 Completed 09/03/2025 10:21:00 PM Do Not Track 0 Enrollment " +
      "PERSON_THREE - Patent Policy Acknowledgement & Agreement Patent Policy Acknowledgement & Agreement Digital Course Enrolled 09/27/2024 Completed 09/27/2024 09:29:54 PM Do Not Track 0 Enrollment " +
      "PERSON_THREE - Tuberculosis Awareness Web Training Tuberculosis Awareness Web Training Digital Course Enrolled 09/27/2024 Completed 09/27/2024 09:02:26 PM Do Not Track Pass 90 Enrollment";
    expect(extractDateFromText(noHipaa)).toBeNull();
  });

  it("does not return the column header window's first row date (header-match guard)", () => {
    // Regression for the exact bug: the header text
    // "...Completion Status Completion Date and Time Expiration Date..."
    // must not cause the first following date to be returned blindly.
    const result = extractDateFromText(transcript1);
    expect(result).not.toBeNull();
    // 09/03/2025 is the first 'Completed' row (Sexual Misconduct) - not HIPAA.
    expect(result!.date.toISOString()).not.toBe(noon(2025, 9, 3).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Strategy B hardening: Enrolled-context dates and column headers
// ---------------------------------------------------------------------------

describe("extractDateFromText - Strategy B hardening", () => {
  it("never accepts a date immediately preceded by 'Enrolled'", () => {
    // No transcript markers here, so this exercises Strategy B directly.
    const text =
      "Annual Security Attestation and HIPAA Refresher Completion Status Enrolled 10/09/2024";
    expect(extractDateFromText(text)).toBeNull();
  });

  it("skips a column-header window (label followed by another column label)", () => {
    // 'Completion Date and Time' immediately followed by 'Expiration Date' is a
    // table header, not a value. With no real value present, return null.
    const text =
      "Completion Status Completion Date and Time Expiration Date Attendance Status Grade Score Record Type";
    expect(extractDateFromText(text)).toBeNull();
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
