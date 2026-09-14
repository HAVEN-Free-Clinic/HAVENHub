import { describe, expect, it } from "vitest";
import { applicationOwnerAmong, isOwnApplication, type ReviewerIdentity } from "./own-application";

const me: ReviewerIdentity = { personId: "p1", netId: "sk123", emails: ["shriya@gmail.com", "sk123@yale.edu"] };

function applicant(over: Partial<{ applicantPersonId: string | null; emailLower: string; netId: string | null }> = {}) {
  return { applicantPersonId: null, emailLower: "someone@yale.edu", netId: null, ...over };
}

describe("isOwnApplication", () => {
  it("recognises an application linked to the reviewer's account", () => {
    expect(isOwnApplication(applicant({ applicantPersonId: "p1" }), me)).toBe(true);
  });

  it("recognises an unlinked application by the reviewer's NetID, ignoring case and spaces", () => {
    // An applicant who applied signed out has no account link, which is the
    // case every per-account self check used to miss.
    expect(isOwnApplication(applicant({ netId: " SK123 " }), me)).toBe(true);
  });

  it("recognises an unlinked application by the reviewer's contact or Yale address", () => {
    expect(isOwnApplication(applicant({ emailLower: "shriya@gmail.com" }), me)).toBe(true);
    expect(isOwnApplication(applicant({ emailLower: "SK123@yale.edu" }), me)).toBe(true);
  });

  it("does not match someone else's application", () => {
    expect(isOwnApplication(applicant({ applicantPersonId: "p2", emailLower: "other@yale.edu", netId: "ot456" }), me)).toBe(false);
  });

  it("never matches two blanks as the same person", () => {
    const blank: ReviewerIdentity = { personId: "p3", netId: null, emails: [] };
    expect(isOwnApplication(applicant({ netId: null, emailLower: "" }), blank)).toBe(false);
  });
});

describe("applicationOwnerAmong", () => {
  it("names the pool member whose application it is, linked or not", () => {
    const pool: ReviewerIdentity[] = [{ personId: "p9", netId: "zz9", emails: [] }, me];
    expect(applicationOwnerAmong(applicant({ emailLower: "sk123@yale.edu" }), pool)).toBe("p1");
  });

  it("falls back to the account link when nobody in the pool matches", () => {
    expect(applicationOwnerAmong(applicant({ applicantPersonId: "p7" }), [me])).toBe("p7");
    expect(applicationOwnerAmong(applicant(), [me])).toBeNull();
  });
});
