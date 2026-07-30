import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Department, Term, TermMembership } from "@prisma/client";

// ConfirmButton is a client component that reads useFormStatus(); stub it so the
// card can render through renderToStaticMarkup in the node test environment.
vi.mock("@/platform/ui/confirm-button", () => ({
  ConfirmButton: ({ label }: { label: string }) => <button type="submit">{label}</button>,
}));

const { MembershipsCard } = await import("./memberships-card");

const term = { id: "t1", code: "SU26" } as Term;
const department = { id: "d1", code: "MED", name: "Medicine" } as Department;

function membership(kind: "VOLUNTEER" | "DIRECTOR"): TermMembership & { department: Department; term: Term } {
  return { id: `m-${kind}`, personId: "p1", termId: "t1", departmentId: "d1", kind, status: "ACTIVE", department, term } as TermMembership & { department: Department; term: Term };
}

const noop = async () => {};

describe("MembershipsCard", () => {
  it("offers an optional reason field beside the withdraw button", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard memberships={[membership("VOLUNTEER")]} withdrawAction={noop} />,
    );

    expect(html).toContain('name="reason"');
    expect(html).toContain("I am not volunteering this term");
  });

  it("shows no reason field when the member has no volunteer assignment", () => {
    const html = renderToStaticMarkup(
      <MembershipsCard memberships={[membership("DIRECTOR")]} withdrawAction={noop} />,
    );

    expect(html).not.toContain('name="reason"');
    expect(html).toContain("contact the executive directors");
  });
});
