import { describe, expect, it } from "vitest";
import { SupportHistoryNotificationError } from "./index";

/**
 * The guard itself (counting EmailLog/TeamsMessage/Notification either side of
 * the run) is exercised through the importer's own tests. What is pinned here is
 * the thing that misled an operator: the DISPOSITION sentence, which has to come
 * from the path rather than being hardcoded.
 *
 * The check runs after both paths, but only the dry run rolled anything back. On
 * the apply path the transaction has already committed and attachments have
 * already been uploaded by the time this throws, so a blanket "the transaction
 * was rolled back" told an operator mid-cutover that nothing was written when in
 * fact everything was, and invited a re-run on a false premise.
 */
describe("SupportHistoryNotificationError", () => {
  const deltas = "EmailLog +2, Notification +1";

  it("says nothing was written on the dry-run path", () => {
    const err = new SupportHistoryNotificationError(deltas, true);
    expect(err.message).toContain("rolled back");
    expect(err.message).toContain("nothing was written");
  });

  it("does NOT claim a rollback on the apply path", () => {
    const err = new SupportHistoryNotificationError(deltas, false);
    // The specific regression: an apply-path failure must never tell the
    // operator the write was undone.
    expect(err.message).not.toMatch(/rolled back/i);
    expect(err.message).not.toMatch(/nothing was written/i);
  });

  it("tells the apply path what is already committed and what to inspect", () => {
    const err = new SupportHistoryNotificationError(deltas, false);
    expect(err.message).toContain("ALREADY COMMITTED");
    expect(err.message).toContain("EmailLog");
    expect(err.message).toContain("Do not re-run before");
  });

  it("carries the deltas and keeps the invariant it is guarding on both paths", () => {
    for (const dryRun of [true, false]) {
      const err = new SupportHistoryNotificationError(deltas, dryRun);
      expect(err.name).toBe("SupportHistoryNotificationError");
      expect(err.message).toContain(deltas);
      expect(err.message).toContain("must never reach notify() or queueEmail()");
    }
  });
});
