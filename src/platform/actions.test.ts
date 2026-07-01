import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${url}` });
    throw e;
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { runAction } from "./actions";
class DomainError extends Error {}

describe("runAction", () => {
  it("revalidates on success", async () => {
    revalidatePath.mockClear();
    await runAction({ work: async () => {}, domainErrors: [DomainError], errorRedirect: () => "/e", revalidate: "/p" });
    expect(revalidatePath).toHaveBeenCalledWith("/p");
  });
  it("redirects on a named domain error", async () => {
    await expect(runAction({
      work: async () => { throw new DomainError("bad"); },
      domainErrors: [DomainError], errorRedirect: (m) => `/e?m=${m}`,
    })).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/e?m=bad" });
  });
  it("propagates a Next redirect sentinel untouched", async () => {
    const sentinel = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;/x" });
    await expect(runAction({
      work: async () => { throw sentinel; }, domainErrors: [DomainError], errorRedirect: () => "/e",
    })).rejects.toBe(sentinel);
  });
  it("propagates an unknown error", async () => {
    const boom = new Error("boom");
    await expect(runAction({
      work: async () => { throw boom; }, domainErrors: [DomainError], errorRedirect: () => "/e",
    })).rejects.toBe(boom);
  });
});
