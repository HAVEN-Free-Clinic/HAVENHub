import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { systemFieldOptions } from "@/modules/recruitment/contract/system-fields";
import type { SystemFieldBlock } from "@/modules/recruitment/contract/layout";
import { DetailsReview, reviewRows, type ReviewPrefill } from "./details-review";

const blocks: SystemFieldBlock[] = [
  { kind: "system_field", systemKey: "name" },
  { kind: "system_field", systemKey: "email" },
  { kind: "system_field", systemKey: "phone" },
  { kind: "system_field", systemKey: "pronouns" },
  { kind: "system_field", systemKey: "yaleAffiliation" },
];
const prefill: ReviewPrefill = {
  firstName: "Ada", legalMiddleName: "", lastName: "Lovelace", preferredFirstName: "Addy",
  email: "ada@yale.edu", netId: "al99", phone: "2035550100", pronouns: "",
  yaleAffiliation: "staff", gradYear: "",
};
const noErr = () => undefined;
/** One bare input per block, so the markup shows exactly where each one landed. */
const renderField = (b: SystemFieldBlock) => <input key={b.systemKey} name={b.systemKey} />;
const render = (
  p: ReviewPrefill,
  err: (k: string) => string | undefined = noErr,
  bs: SystemFieldBlock[] = blocks,
) => renderToStaticMarkup(<DetailsReview blocks={bs} prefill={p} err={err} renderField={renderField} />);

/** The contents of the hidden wrapper. renderField emits no nested divs, so the
 *  lazy match ends at the wrapper's own closing tag. */
const hiddenPart = (out: string) => out.match(/<div hidden=""[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";

describe("reviewRows", () => {
  it("summarizes what the application collected, with labels and formatting", () => {
    const staff = systemFieldOptions("yaleAffiliation", "staff").find((o) => o.value === "staff")!.label;
    expect(reviewRows(blocks, prefill)).toEqual([
      { label: "Legal name", value: "Ada Lovelace" },
      { label: "Goes by", value: "Addy" },
      { label: "Email", value: "ada@yale.edu" },
      { label: "Phone", value: "(203) 555-0100" },
      { label: "Pronouns", value: null },
      { label: "Yale affiliation", value: staff },
    ]);
  });
});

describe("DetailsReview", () => {
  it("shows the summary and keeps the inputs posting, hidden, until they choose to update", () => {
    const out = render(prefill);
    expect(out).toContain("We have these details from your application.");
    expect(out).toContain("Update my details");
    expect(hiddenPart(out)).toContain('name="name"');
  });

  it("opens the inputs when the server rejected one of these fields", () => {
    const out = render(prefill, (k) => (k === "email" ? "required" : undefined));
    expect(out).not.toContain("Update my details");
    expect(out).not.toContain('hidden=""');
  });
});

describe("DetailsReview with a required detail the application never collected", () => {
  // The FA26 volunteer template marks yaleAffiliation/gradYear/phone required,
  // but 241 of 430 accepted applicants had no affiliation on file. Rendered
  // `required` inside the summary's `hidden` wrapper, the browser refuses to
  // submit the form and cannot focus the control to say why: pressing "Submit
  // onboarding" does nothing at all, with no message anywhere on the page.
  const requiredAffiliation: SystemFieldBlock[] = [
    { kind: "system_field", systemKey: "name" },
    { kind: "system_field", systemKey: "email" },
    { kind: "system_field", systemKey: "yaleAffiliation", required: true },
  ];

  it("asks it as a visible field, never hidden", () => {
    const out = render({ ...prefill, yaleAffiliation: "" }, noErr, requiredAffiliation);
    expect(out).toContain('name="yaleAffiliation"');
    expect(hiddenPart(out)).not.toContain('name="yaleAffiliation"');
  });

  it("leaves every other detail as a collapsed summary", () => {
    const out = render({ ...prefill, yaleAffiliation: "" }, noErr, requiredAffiliation);
    expect(out).toContain("Update my details");
    expect(hiddenPart(out)).toContain('name="name"');
    // Asked as a field, so it is not also listed as "Not provided" above.
    expect(out).not.toContain("Yale affiliation</dt>");
  });

  it("asks a blank core detail the same way", () => {
    const out = render({ ...prefill, email: "" });
    expect(out).toContain('name="email"');
    expect(hiddenPart(out)).not.toContain('name="email"');
    expect(hiddenPart(out)).toContain('name="name"');
  });

  it("still collapses the summary when every required detail is present", () => {
    const out = render({ ...prefill, yaleAffiliation: "staff" }, noErr, requiredAffiliation);
    expect(out).toContain('hidden=""');
    expect(hiddenPart(out)).toContain('name="yaleAffiliation"');
  });
});
