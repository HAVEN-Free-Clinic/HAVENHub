import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { ClinicDateStrip } = await import("./clinic-date-strip");

/** Noon-UTC anchored calendar date, matching how the schema stores clinicDate. */
function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

const DATES = [d(2026, 9, 6), d(2026, 9, 20), d(2026, 10, 4)];

describe("ClinicDateStrip", () => {
  it("labels the nav with the caller's aria-label", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toContain('aria-label="Clinic dates"');
  });

  it("groups consecutive dates under one month label and starts a new group at a month change", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toContain("September 2026");
    expect(out).toContain("October 2026");
    // September appears once even though it holds two dates.
    expect(out.match(/September 2026/g)).toHaveLength(1);
  });

  it("marks only the selected date with aria-current", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey="2026-09-20" hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("builds each link with the caller's hrefFor", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/schedule/full?date=${k}`} ariaLabel="Schedule dates" />,
    );
    expect(out).toContain('href="/schedule/full?date=2026-09-06"');
    expect(out).toContain('href="/schedule/full?date=2026-10-04"');
  });

  it("renders one link per date", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={DATES} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out.match(/<a /g)).toHaveLength(3);
  });

  it("renders nothing when there are no clinic dates", () => {
    const out = renderToStaticMarkup(
      <ClinicDateStrip dates={[]} selectedKey={null} hrefFor={(k) => `/x?date=${k}`} ariaLabel="Clinic dates" />,
    );
    expect(out).toBe("");
  });
});
