import { describe, expect, it, vi, beforeEach } from "vitest";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: dns.lookup }));

import { getPublicJson, publicOnlyLookup } from "./safe-fetch";

type Answer = { address: string; family: number }[];
function answer(addresses: Answer) {
  dns.lookup.mockImplementationOnce((_h: string, _o: unknown, cb: (e: null, a: Answer) => void) => cb(null, addresses));
}

function runLookup(all: boolean): Promise<{ err: (Error & { code?: string }) | null; result: unknown }> {
  return new Promise((resolve) =>
    publicOnlyLookup("client.example", { all } as never, ((err: Error | null, result: unknown) =>
      resolve({ err, result })) as never),
  );
}

beforeEach(() => dns.lookup.mockReset());

describe("publicOnlyLookup", () => {
  it("passes public addresses through, in both callback shapes", async () => {
    answer([{ address: "160.79.104.10", family: 4 }]);
    expect(await runLookup(false)).toEqual({ err: null, result: "160.79.104.10" });
    answer([{ address: "160.79.104.10", family: 4 }]);
    expect((await runLookup(true)).result).toEqual([{ address: "160.79.104.10", family: 4 }]);
  });

  it("refuses when ANY resolved address is private, not just the first", async () => {
    answer([
      { address: "160.79.104.10", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    expect((await runLookup(false)).err?.code).toBe("EPRIVATE");
  });
});

describe("getPublicJson", () => {
  it("refuses a host that resolves privately at connect time, resolving exactly once", async () => {
    // DNS rebinding: the only resolution is the socket's own, so there is no
    // earlier "check" answer for an attacker's name server to diverge from.
    answer([{ address: "127.0.0.1", family: 4 }]);
    await expect(getPublicJson("https://rebind.example/client.json")).rejects.toMatchObject({ code: "EPRIVATE" });
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });
});
