import { describe, expect, it } from "vitest";
import {
  epicKindForRequestType,
  requestTypeForGroup,
  type EpicRequestType,
} from "./epic-request-types";

describe("epicKindForRequestType", () => {
  it("maps the new types to NEW", () => {
    expect(epicKindForRequestType("new_individual")).toBe("NEW");
    expect(epicKindForRequestType("bulk_new")).toBe("NEW");
  });

  it("maps both modify types to MODIFY, including bulk_mod", () => {
    expect(epicKindForRequestType("mod_individual")).toBe("MODIFY");
    // Regression: bulk_mod used to be tracked as RENEW, so a modify batch was
    // recorded as a renewal.
    expect(epicKindForRequestType("bulk_mod")).toBe("MODIFY");
  });

  it("maps both renew types to RENEW", () => {
    expect(epicKindForRequestType("renew_individual")).toBe("RENEW");
    expect(epicKindForRequestType("bulk_renew")).toBe("RENEW");
  });

  it("maps both deactivate types to DEACTIVATE", () => {
    expect(epicKindForRequestType("deactivate_individual")).toBe("DEACTIVATE");
    expect(epicKindForRequestType("bulk_deactivate")).toBe("DEACTIVATE");
  });

  it("maps every request type to exactly the expected kind", () => {
    const expected: Record<EpicRequestType, string> = {
      new_individual: "NEW",
      bulk_new: "NEW",
      mod_individual: "MODIFY",
      bulk_mod: "MODIFY",
      renew_individual: "RENEW",
      bulk_renew: "RENEW",
      deactivate_individual: "DEACTIVATE",
      bulk_deactivate: "DEACTIVATE",
    };
    for (const [type, kind] of Object.entries(expected)) {
      expect(epicKindForRequestType(type as EpicRequestType)).toBe(kind);
    }
  });
});

describe("requestTypeForGroup", () => {
  it("uses the individual type for a single person", () => {
    expect(requestTypeForGroup("NEW", 1)).toBe("new_individual");
    expect(requestTypeForGroup("MODIFY", 1)).toBe("mod_individual");
    expect(requestTypeForGroup("RENEW", 1)).toBe("renew_individual");
  });

  it("uses the bulk type for more than one person", () => {
    expect(requestTypeForGroup("NEW", 2)).toBe("bulk_new");
    expect(requestTypeForGroup("MODIFY", 12)).toBe("bulk_mod");
    expect(requestTypeForGroup("RENEW", 41)).toBe("bulk_renew");
  });

  it("round-trips back to the group kind it was built from", () => {
    for (const kind of ["NEW", "MODIFY", "RENEW"] as const) {
      for (const count of [1, 5]) {
        expect(epicKindForRequestType(requestTypeForGroup(kind, count))).toBe(kind);
      }
    }
  });
});
