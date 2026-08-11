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

  it("records a denial distinctly from a success", async () => {
    await recordToolCall({ personId: "p1", tool: "my_next_shift", args: {}, outcome: "denied" });

    expect(mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "intercom_mcp.denied" })
    );
  });
});
