import { describe, expect, it } from "vitest";
import {
  BOARD_ATTENDANCE_STATUSES,
  BOARD_ATTENDANCE_LABELS,
} from "./board-attendance";

/**
 * /volunteers/board-meetings/[id] used to derive these words twice and disagree:
 * the chip rendered `status.toLowerCase()` ("present") and the Select beside it
 * rendered `s.charAt(0) + s.slice(1).toLowerCase()` ("Present"). One screen,
 * three values, two spellings, and the chip read as a leaked database constant.
 */
describe("BOARD_ATTENDANCE_LABELS", () => {
  it("covers every status, so a new one cannot fall back to the raw enum", () => {
    expect(Object.keys(BOARD_ATTENDANCE_LABELS).sort()).toEqual(
      [...BOARD_ATTENDANCE_STATUSES].sort(),
    );
  });

  it("never shows the enum value itself", () => {
    for (const [value, { label }] of Object.entries(BOARD_ATTENDANCE_LABELS)) {
      expect(label).not.toBe(value);
      expect(label).not.toMatch(/^[A-Z][A-Z_]+$/);
      // Nor the lowercased one the chip used to render.
      expect(label).not.toBe(value.toLowerCase());
    }
  });

  it("is sentence case, which is what the Select already showed", () => {
    expect(BOARD_ATTENDANCE_LABELS.PRESENT.label).toBe("Present");
    expect(BOARD_ATTENDANCE_LABELS.EXCUSED.label).toBe("Excused");
    expect(BOARD_ATTENDANCE_LABELS.ABSENT.label).toBe("Absent");
  });

  it("gives a missed meeting a critical tone and attendance a success one", () => {
    expect(BOARD_ATTENDANCE_LABELS.PRESENT.tone).toBe("success");
    expect(BOARD_ATTENDANCE_LABELS.ABSENT.tone).toBe("critical");
  });
});
