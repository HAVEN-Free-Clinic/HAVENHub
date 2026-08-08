import { describe, it, expect } from "vitest";
import { isClientDetectedFailureReason } from "./check-in-client-reasons";

describe("isClientDetectedFailureReason", () => {
  it("accepts every reason the client can genuinely produce", () => {
    expect(isClientDetectedFailureReason("PERMISSION_DENIED")).toBe(true);
    expect(isClientDetectedFailureReason("POSITION_UNAVAILABLE")).toBe(true);
    expect(isClientDetectedFailureReason("TIMEOUT")).toBe(true);
  });

  it("rejects a reason only the server can rule on, so it can't be spoofed into the client-failure event", () => {
    // These are real CheckInFailureReason members, just never ones checkInSelf
    // hands to the client before a server round trip -- a caller of the
    // reportClientFailure action could still try to send one.
    expect(isClientDetectedFailureReason("OUT_OF_RANGE")).toBe(false);
    expect(isClientDetectedFailureReason("TOO_IMPRECISE")).toBe(false);
    expect(isClientDetectedFailureReason("NOT_ASSIGNED")).toBe(false);
    expect(isClientDetectedFailureReason("NOT_ELIGIBLE")).toBe(false);
  });

  it("rejects arbitrary and empty input rather than passing it through", () => {
    expect(isClientDetectedFailureReason("")).toBe(false);
    expect(isClientDetectedFailureReason("DROP TABLE ClinicAttendance")).toBe(false);
    expect(isClientDetectedFailureReason("permission_denied")).toBe(false); // case-sensitive
  });
});
