import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const flush = vi.fn(async () => {});
vi.mock("@/platform/posthog/posthog-server", () => ({
  getPostHogClient: () => ({ captureException, flush }),
}));

import { distinctIdFromCookie, onRequestError } from "./request-error";

const cookieFor = (distinctId: string) =>
  `foo=bar; ph_phc_abc123_posthog=${encodeURIComponent(
    JSON.stringify({ distinct_id: distinctId }),
  )}; baz=qux`;

describe("distinctIdFromCookie", () => {
  it("extracts the distinct_id from the posthog cookie", () => {
    expect(distinctIdFromCookie(cookieFor("person-42"))).toBe("person-42");
  });

  it("returns undefined when no posthog cookie is present", () => {
    expect(distinctIdFromCookie("session=abc; theme=dark")).toBeUndefined();
  });

  it("returns undefined for a malformed posthog cookie", () => {
    expect(distinctIdFromCookie("ph_phc_abc_posthog=not%20json")).toBeUndefined();
  });

  it("returns undefined when the cookie header is missing", () => {
    expect(distinctIdFromCookie(undefined)).toBeUndefined();
  });
});

describe("onRequestError", () => {
  const OLD_RUNTIME = process.env.NEXT_RUNTIME;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    process.env.NEXT_RUNTIME = OLD_RUNTIME;
  });

  it("does nothing outside the node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await onRequestError(new Error("boom"), { headers: {} }, {});
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures the exception with the cookie distinctId and route context, then flushes", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const err = new Error("boom");
    await onRequestError(
      err,
      { path: "/recruitment", method: "POST", headers: { cookie: cookieFor("person-7") } },
      { routerKind: "App Router", routePath: "/recruitment", routeType: "action" },
    );
    expect(captureException).toHaveBeenCalledWith(err, "person-7", {
      path: "/recruitment",
      method: "POST",
      router_kind: "App Router",
      route_path: "/recruitment",
      route_type: "action",
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("captures with an undefined distinctId when no cookie is present", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await onRequestError(new Error("x"), { headers: {} }, {});
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.any(Object),
    );
  });
});
