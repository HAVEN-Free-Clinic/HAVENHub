import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvBanner } from "./env-banner";

describe("EnvBanner", () => {
  it("shows the label and the not-production notice when a label is set", () => {
    const out = renderToStaticMarkup(<EnvBanner label="Staging" />);
    expect(out).toContain("Staging");
    expect(out).toContain("not production data");
  });

  it("announces politely via role=status so meaning is not color-only", () => {
    const out = renderToStaticMarkup(<EnvBanner label="Staging" />);
    expect(out).toContain('role="status"');
  });

  it("renders nothing when the label is an empty string (production)", () => {
    expect(renderToStaticMarkup(<EnvBanner label="" />)).toBe("");
  });

  it("renders nothing when the label is undefined", () => {
    expect(renderToStaticMarkup(<EnvBanner label={undefined} />)).toBe("");
  });
});
