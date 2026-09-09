import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ReadonlyField, Field } from "./input";

describe("ReadonlyField", () => {
  it("renders the label as muted text and the value as static foreground text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "CARNEYJU" });
    expect(el.type).toBe("div");
    const [labelSpan, valueP] = el.props.children;
    expect(labelSpan.props.children).toBe("Epic ID");
    expect(labelSpan.props.className).toContain("text-muted-foreground");
    expect(valueP.type).toBe("p");
    expect(valueP.props.children).toBe("CARNEYJU");
    expect(valueP.props.className).toContain("border-b");
    expect(valueP.props.className).toContain("text-foreground");
  });

  it("shows a 'Not set' placeholder when value is empty", () => {
    const el = ReadonlyField({ label: "Phone", value: "" });
    const valueP = el.props.children[1];
    expect(JSON.stringify(valueP.props.children)).toContain("Not set");
  });

  it("renders an optional hint as subtle text", () => {
    const el = ReadonlyField({ label: "Epic ID", value: "X", hint: "Contact IT" });
    const hint = el.props.children[2];
    expect(hint.props.children).toBe("Contact IT");
    expect(hint.props.className).toContain("text-subtle-foreground");
  });
});

describe("Field", () => {
  it("renders a required marker when required is true", () => {
    const el = Field({ label: "Name", required: true, children: null });
    const labelEl = el.props.children[0];
    const labelSpan = labelEl.props.children[0];
    const [, marker] = labelSpan.props.children;
    expect(marker).toBeTruthy();
    // Exact, not toContain("text-critical"): the vivid `text-critical` is a
    // SUBSTRING of `text-critical-foreground`, so a containment check passes for
    // either and cannot tell them apart. The marker is text, so it owes AA (4.5:1)
    // and must use the -foreground variant; the vivid token is for icons and fills
    // at 3:1. See theme-contrast.test.ts.
    expect(marker.props.className).toBe("text-critical-foreground");
  });

  it("does not render a required marker by default", () => {
    const el = Field({ label: "Name", children: null });
    const labelEl = el.props.children[0];
    const labelSpan = labelEl.props.children[0];
    const [, marker] = labelSpan.props.children;
    expect(marker).toBeFalsy();
  });
});

/**
 * A validated form has to SHOW the message, TIE it to the control, and ANNOUNCE
 * it. The onboarding contract at /onboard/[token] did the first two by hand, in
 * ten copies, and never did the third -- so a rejected HIPAA date or Epic ID
 * re-rendered the page in silence, while the same fields in the /apply wizard
 * announced fine. These pin all three.
 */
describe("Field error", () => {
  const errorNode = (el: ReturnType<typeof Field>) => el.props.children[1];

  it("announces the message, which is the part that was missing", () => {
    const el = Field({ label: "HIPAA completion date", error: "Enter a date.", children: null });
    expect(errorNode(el).props.role).toBe("alert");
    expect(errorNode(el).props.children).toBe("Enter a date.");
    // Text, so it owes AA: the -foreground variant, not the vivid 3:1 token.
    expect(errorNode(el).props.className).toContain("text-critical-foreground");
  });

  it("ties the message to the control and marks it invalid", () => {
    const input = createElement("input", { name: "hipaaCompletedAt" });
    const el = Field({ label: "HIPAA completion date", error: "Enter a date.", children: input });
    const control = el.props.children[0].props.children[2];
    expect(control.props["aria-invalid"]).toBe(true);
    expect(control.props["aria-describedby"]).toBe(errorNode(el).props.id);
  });

  it("sets aria-invalid only when there IS an error", () => {
    // A bare aria-invalid="false" on every field in the app is noise, and some
    // readers announce it.
    const input = createElement("input", { name: "x" });
    const el = Field({ label: "Name", children: input });
    const control = el.props.children[0].props.children[2];
    expect(control.props["aria-invalid"]).toBeUndefined();
  });

  it("keys the id off the control name, because two fields can share a label", () => {
    // An onboarding contract renders custom questions an author wrote, and
    // nothing stops two of them saying "Date". A duplicated id makes
    // aria-describedby resolve to whichever came first, quietly describing one
    // field with another field's message.
    const a = Field({ label: "Date", error: "bad", children: createElement("input", { name: "startsAt" }) });
    const b = Field({ label: "Date", error: "bad", children: createElement("input", { name: "endsAt" }) });
    expect(errorNode(a).props.id).not.toBe(errorNode(b).props.id);
  });

  it("replaces the bottom hint rather than stacking a second instruction under one control", () => {
    const el = Field({ label: "Your Epic ID", hint: "Enter it in capital letters.", error: "Required.", children: null });
    expect(errorNode(el).props.role).toBe("alert");
    expect(JSON.stringify(el.props.children)).not.toContain("capital letters");
  });

  it("does not describe the control with a hint it is no longer rendering", () => {
    // The dangling-id bug: keeping hintId in aria-describedby while the hint
    // element is gone points the reader at nothing.
    const input = createElement("input", { name: "existingEpicId" });
    const el = Field({
      label: "Your Epic ID",
      hint: "Enter it in capital letters.",
      error: "Required.",
      children: input,
    });
    const control = el.props.children[0].props.children[2];
    expect(control.props["aria-describedby"]).toBe(errorNode(el).props.id);
  });

  it("keeps a TOP hint, which is guidance read before typing", () => {
    const el = Field({
      label: "Departments",
      hint: "Pick every one you want.",
      hintPosition: "top",
      error: "Pick at least one.",
      children: null,
    });
    expect(JSON.stringify(el.props.children[0])).toContain("Pick every one you want.");
    expect(errorNode(el).props.role).toBe("alert");
  });
});
