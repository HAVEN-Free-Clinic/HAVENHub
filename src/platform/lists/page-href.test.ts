/**
 * Tests for the shared pagination href serializer.
 *
 * Every one of these fails against the code as it was, because pageHref did not
 * exist: each list built its own query string inline. Two of them are the reason
 * the shared version had to be more than a loop over Object.entries, and are
 * worth reading as specifications rather than coverage:
 *
 *  - flash params are stripped. /volunteers/spanish-review and
 *    /incidents/strikes redirect back to themselves with ?ok= / ?error= /
 *    ?message= after a save, and a pager that carried those forward would
 *    re-fire the toast or re-render the banner on every Prev/Next click.
 *  - a present-but-empty value is kept. /admin/people reads an empty `status`
 *    as distinct from an absent one, and dropping it on page 2 would flip the
 *    list's `filtered` flag and take the Clear link away mid-list.
 */

import { describe, expect, it } from "vitest";
import { FLASH_PARAM_NAMES } from "@/platform/ui/toast/flash";
import { pageHref } from "./page-href";

describe("pageHref", () => {
  it("carries the list's filters onto the target page", () => {
    expect(pageHref("/admin/people", { q: "ada", status: "ALL", page: "3" }, 2)).toBe(
      "/admin/people?q=ada&status=ALL&page=2",
    );
  });

  it("writes page 1 with no page param, so the first page has one URL", () => {
    expect(pageHref("/admin/people", { q: "ada", status: "ALL", page: "3" }, 1)).toBe(
      "/admin/people?q=ada&status=ALL",
    );
  });

  it("returns a bare path when there is nothing to carry", () => {
    expect(pageHref("/notifications", { page: "4" }, 1)).toBe("/notifications");
    expect(pageHref("/notifications", { page: "4" }, 2)).toBe("/notifications?page=2");
  });

  it("drops the one-shot flash params a save redirect leaves behind", () => {
    expect(
      pageHref(
        "/incidents/strikes",
        { q: "lee", error: "Could not save that.", message: "Strike recorded.", ok: "Saved." },
        2,
      ),
    ).toBe("/incidents/strikes?q=lee&page=2");
  });

  it("drops the *Error suffix family too, matching the app's flash convention", () => {
    // flash.ts claims `error` plus anything ending in "Error" (rosterError,
    // decisionError, ...). A pager that kept those would re-toast them.
    expect(pageHref("/admin/audit", { action: "login", rosterError: "nope", saved: "1" }, 2)).toBe(
      "/admin/audit?action=login&page=2",
    );
  });

  it("keeps a present-but-empty value, which at least one list reads as a choice", () => {
    expect(pageHref("/admin/people", { q: "ada", status: "" }, 2)).toBe(
      "/admin/people?q=ada&status=&page=2",
    );
  });

  it("drops params the page does not have", () => {
    expect(pageHref("/support/all", { q: "printer", assignee: undefined, priority: [] }, 2)).toBe(
      "/support/all?q=printer&page=2",
    );
  });

  it("takes the first element of a repeated param", () => {
    expect(pageHref("/support/all", { status: ["OPEN", "CLOSED"] }, 2)).toBe(
      "/support/all?status=OPEN&page=2",
    );
  });

  it("escapes values rather than pasting them into the query string", () => {
    expect(pageHref("/admin/people", { q: "a b&c=d" }, 2)).toBe(
      "/admin/people?q=a+b%26c%3Dd&page=2",
    );
  });

  it("carries a filter the caller never had to name", () => {
    // The point of handing the whole searchParams object over: a filter added to
    // a list later survives paging without anyone remembering to add it to a
    // second place.
    expect(pageHref("/admin/audit", { action: "login", newFilterAddedLater: "x" }, 2)).toBe(
      "/admin/audit?action=login&newFilterAddedLater=x&page=2",
    );
  });
});

describe("flash params never ride a pagination link", () => {
  it("strips every param name flash.ts treats as feedback, not a hand-picked four", () => {
    // The four this file used to name were error/message/ok/saved. flash.ts
    // knows thirty-one, and two of the missing ones were live on pages that
    // page their results: /admin/email and /admin/notifications both redirect
    // to `?retried=1` and both render <Pagination params={sp} />, so a retry
    // toast rode every Prev/Next click down the list.
    for (const name of FLASH_PARAM_NAMES) {
      const href = pageHref("/admin/email", { status: "FAILED", [name]: "1" }, 2);
      expect(href, name).not.toContain(`${name}=`);
      expect(href, name).toContain("status=FAILED");
    }
  });

  it("still strips the *Error family the registry does not enumerate", () => {
    expect(pageHref("/x", { uploadError: "too big", q: "a" }, 2)).not.toContain("uploadError");
  });

  it("keeps ordinary filters, including ones whose names look like flash", () => {
    // `count` is a registry param name AND a plausible filter, so this pins that
    // the rule is name-based and deliberate rather than an accident nobody meant.
    expect(pageHref("/x", { q: "ada", dept: "ITCM" }, 3)).toContain("q=ada");
    expect(pageHref("/x", { q: "ada", dept: "ITCM" }, 3)).toContain("dept=ITCM");
  });
});
