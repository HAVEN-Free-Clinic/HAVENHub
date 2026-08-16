import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/platform/audit", () => ({ recordAudit: vi.fn() }));

import { recordAudit } from "@/platform/audit";
import { recordToolCall } from "./audit";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("recordToolCall", () => {
  it("records a successful call against the resolved person", async () => {
    await recordToolCall({
      personId: "p1",
      tool: "my_next_shift",
      args: { includeTags: true },
      outcome: "ok",
    });

    expect(mocked(recordAudit)).toHaveBeenCalledWith({
      actorPersonId: "p1",
      action: "intercom_mcp.ok",
      entityType: "IntercomMcpToolCall",
      entityId: "my_next_shift",
      after: { tool: "my_next_shift", args: { includeTags: true }, outcome: "ok" },
    });
  });

  it("records an unverified call with a null actor, so failed claims are still visible", async () => {
    await recordToolCall({
      personId: null,
      tool: "my_next_shift",
      args: {},
      outcome: "unverified",
    });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ actorPersonId: null, action: "intercom_mcp.unverified" })
    );
  });

  /**
   * The load-bearing case for #370's fix: recordToolCall used to hardcode
   * "unverified" for every identity failure regardless of WHY, so the row
   * could never tell "no conversation id" apart from "conversation with no
   * resolvable contact" apart from "contact whose Person is not active".
   * The reason now travels into the row's payload.
   */
  it("carries the specific identity-failure reason into the row's payload", async () => {
    await recordToolCall({
      personId: null,
      tool: "my_next_shift",
      args: {},
      outcome: "unverified",
      reason: "no_contact",
    });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "intercom_mcp.unverified",
        after: { tool: "my_next_shift", args: {}, outcome: "unverified", reason: "no_contact" },
      })
    );
  });

  it("omits the reason field entirely when none is given, rather than writing it as undefined", async () => {
    await recordToolCall({
      personId: null,
      tool: "my_next_shift",
      args: {},
      outcome: "unverified",
    });

    const call = mocked(recordAudit).mock.calls[0][0] as { after: Record<string, unknown> };
    expect(call.after).not.toHaveProperty("reason");
  });

  it("records a denial distinctly from a success", async () => {
    await recordToolCall({ personId: "p1", tool: "my_next_shift", args: {}, outcome: "denied" });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "intercom_mcp.denied" })
    );
  });
});
