/**
 * Pure render tests for EHS missing-list interpolation in compliance templates.
 *
 * These tests exercise the template engine directly (no DB, no renderEmail).
 * They assert that precomputed ehsMissingList strings round-trip through
 * renderTemplate without leaving any unresolved template tags.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/platform/email/render/render";
import {
  complianceReminderContext,
  complianceEscalationContext,
  complianceDescriptors,
} from "./compliance";

const reminderDescriptor = complianceDescriptors.find((d) => d.key === "compliance-reminder")!;
const escalationDescriptor = complianceDescriptors.find((d) => d.key === "compliance-escalation")!;

describe("compliance-reminder EHS list rendering (pure, no DB)", () => {
  it("renders both EHS training names into the body", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "COMPLIANT",
      expiresAt: null,
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).toContain("BBP Clinical");
    expect(output).toContain("TB Baseline Screening");
  });

  it("does not leave any unresolved template tags in the output", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "COMPLIANT",
      expiresAt: null,
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });

  it("omits the EHS section entirely when ehsMissing is empty", () => {
    const ctx = complianceReminderContext({
      personName: "Sam Student",
      status: "EXPIRING_SOON",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    });
    const output = renderTemplate(reminderDescriptor.defaultBody, ctx);
    expect(output).not.toContain("EHS training is incomplete");
  });
});

describe("compliance-escalation EHS list rendering (pure, no DB)", () => {
  it("renders both EHS training names into the body", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).toContain("BBP Clinical");
    expect(output).toContain("TB Baseline Screening");
  });

  it("does not leave any unresolved template tags in the output", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
      ehsMissing: ["BBP Clinical", "TB Baseline Screening"],
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).not.toContain("#each");
    expect(output).not.toContain("{{");
  });

  it("omits the Outstanding EHS section entirely when ehsMissing is empty", () => {
    const ctx = complianceEscalationContext({
      directorName: "Dr. Director",
      volunteerName: "Sam Student",
      departmentName: "Primary Care",
      status: "EXPIRED",
    });
    const output = renderTemplate(escalationDescriptor.defaultBody, ctx);
    expect(output).not.toContain("Outstanding EHS training");
  });
});
