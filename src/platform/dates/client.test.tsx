import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeZoneProvider, useTimeZone } from "./client";

function Probe() {
  return <span>{useTimeZone()}</span>;
}

describe("TimeZoneProvider / useTimeZone", () => {
  it("provides the zone to consumers", () => {
    const html = renderToStaticMarkup(
      <TimeZoneProvider zone="America/Chicago"><Probe /></TimeZoneProvider>
    );
    expect(html).toContain("America/Chicago");
  });
  it("falls back to the default outside a provider", () => {
    expect(renderToStaticMarkup(<Probe />)).toContain("America/New_York");
  });
});
