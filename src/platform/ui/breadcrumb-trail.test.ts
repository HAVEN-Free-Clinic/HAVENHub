import { describe, it, expect } from "vitest";
import { buildBreadcrumbs, type BreadcrumbModule, type Crumb } from "./breadcrumb-trail";

const modules: BreadcrumbModule[] = [
  {
    id: "admin",
    title: "Admin",
    nav: [
      { label: "Overview", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "Terms", href: "/admin/terms" },
    ],
  },
  { id: "my-info", title: "My Info", nav: [] },
];

const HUB: Crumb = { label: "Hub", href: "/" };

describe("buildBreadcrumbs", () => {
  it("returns Hub alone (current) on the hub root", () => {
    expect(buildBreadcrumbs("/", modules)).toEqual([{ label: "Hub" }]);
  });
  it("module root: Hub > Module(current)", () => {
    expect(buildBreadcrumbs("/admin", modules)).toEqual([HUB, { label: "Admin" }]);
  });
  it("section page: Hub > Module > Section(current)", () => {
    expect(buildBreadcrumbs("/admin/people", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People" },
    ]);
  });
  it("new page: Hub > Module > Section > New(current)", () => {
    expect(buildBreadcrumbs("/admin/people/new", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "New" },
    ]);
  });
  it("detail id page: trail ends at the section link, no leaf", () => {
    expect(buildBreadcrumbs("/admin/people/abc123", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
    ]);
  });
  it("detail id page with leafLabel: appends the supplied name (option B)", () => {
    expect(buildBreadcrumbs("/admin/people/abc123", modules, "Jane Doe")).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People", href: "/admin/people" },
      { label: "Jane Doe" },
    ]);
  });
  it("module with no sections: Hub > Module(current)", () => {
    expect(buildBreadcrumbs("/my-info", modules)).toEqual([HUB, { label: "My Info" }]);
  });
  it("unknown module: just the Hub escape", () => {
    expect(buildBreadcrumbs("/nope", modules)).toEqual([HUB]);
  });
  it("ignores a trailing slash", () => {
    expect(buildBreadcrumbs("/admin/people/", modules)).toEqual([
      HUB,
      { label: "Admin", href: "/admin" },
      { label: "People" },
    ]);
  });
});
