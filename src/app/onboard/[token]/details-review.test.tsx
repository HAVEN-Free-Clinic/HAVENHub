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
const render = (p: ReviewPrefill, err: (k: string) => string | undefined = noErr) =>
  renderToStaticMarkup(
    <DetailsReview blocks={blocks} prefill={p} err={err}>
      <input name="firstName" defaultValue={p.firstName} />
    </DetailsReview>,
  );

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
    expect(out).toMatch(/<div hidden=""[^>]*><input name="firstName"/);
  });

  it("opens the inputs straight away when a required detail is missing", () => {
    const out = render({ ...prefill, email: "" });
    expect(out).not.toContain("Update my details");
    expect(out).not.toContain('hidden=""');
  });

  it("opens the inputs when the server rejected one of these fields", () => {
    const out = render(prefill, (k) => (k === "email" ? "required" : undefined));
    expect(out).not.toContain("Update my details");
    expect(out).not.toContain('hidden=""');
  });
});
