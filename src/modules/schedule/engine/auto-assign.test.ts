import { describe, it, expect } from "vitest";
import { autoAssign, type AutoAssignInput, type AutoAssignMember } from "./auto-assign";

const D1 = "2026-10-03";
const D2 = "2026-10-10";
const D3 = "2026-10-17";

function member(id: string, over: Partial<AutoAssignMember> = {}): AutoAssignMember {
  return {
    id,
    availableDateKeys: [D1, D2, D3],
    requestedShifts: null,
    interpreterScore: null,
    conflictDateKeys: [],
    ...over,
  };
}

function run(over: Partial<AutoAssignInput> = {}) {
  const input: AutoAssignInput = {
    dateKeys: [D1],
    members: [],
    alreadyAssigned: {},
    volunteersOnDate: {},
    cap: null,
    interpreterBar: null,
    fallbackRequestedShifts: 99,
    ...over,
  };
  return autoAssign(input);
}

describe("autoAssign: the per-shift cap", () => {
  it("never puts more volunteers on a date than the cap allows", () => {
    const result = run({
      members: [member("a"), member("b"), member("c"), member("d"), member("e")],
      cap: 2,
    });

    expect(result.additions.filter((x) => x.dateKey === D1)).toHaveLength(2);
  });
});

describe("autoAssign: constraints it must never break", () => {
  it("does not assign someone on a date they are not available", () => {
    const result = run({
      dateKeys: [D1],
      members: [member("a", { availableDateKeys: [D2] })],
    });

    expect(result.additions).toHaveLength(0);
  });

  it("does not assign someone already on the board that date", () => {
    const result = run({
      dateKeys: [D1],
      members: [member("a")],
      alreadyAssigned: { [D1]: ["a"] },
    });

    expect(result.additions).toHaveLength(0);
  });

  it("does not assign someone committed to another department that date", () => {
    const result = run({
      dateKeys: [D1],
      members: [member("a", { conflictDateKeys: [D1] })],
    });

    expect(result.additions).toHaveLength(0);
  });

  it("does not give anyone more shifts than they asked for", () => {
    const result = run({
      dateKeys: [D1, D2, D3],
      members: [member("a", { requestedShifts: 1 })],
    });

    expect(result.additions).toHaveLength(1);
  });

  it("falls back to the given number when a member never stated one", () => {
    const result = run({
      dateKeys: [D1, D2, D3],
      members: [member("a", { requestedShifts: null })],
      fallbackRequestedShifts: 2,
    });

    expect(result.additions).toHaveLength(2);
  });
});

describe("autoAssign: sharing the work out fairly", () => {
  it("counts shifts they already hold toward what they asked for", () => {
    const result = run({
      dateKeys: [D1, D2, D3],
      members: [member("a", { requestedShifts: 2 })],
      alreadyAssigned: { [D1]: ["a"] },
    });

    expect(result.additions).toHaveLength(1);
  });

  it("gives everyone a first shift before anyone gets a second", () => {
    const result = run({
      dateKeys: [D1, D2],
      members: [member("a"), member("b")],
      cap: 1,
    });

    expect(result.additions.map((x) => x.memberId).sort()).toEqual(["a", "b"]);
  });

  it("fills the date fewest people can work before an easier one", () => {
    const result = run({
      dateKeys: [D1, D2],
      members: [
        member("a", { availableDateKeys: [D1, D2] }),
        member("b", { availableDateKeys: [D1] }),
      ],
      cap: 1,
      fallbackRequestedShifts: 1,
    });

    expect(result.additions).toHaveLength(2);
    expect(result.additions).toContainEqual({ dateKey: D2, memberId: "a" });
  });

  it("produces the same schedule whatever order the members arrive in", () => {
    const shared = { dateKeys: [D1, D2], cap: 2, fallbackRequestedShifts: 1 };
    const forward = run({ ...shared, members: [member("a"), member("b"), member("c")] });
    const backward = run({ ...shared, members: [member("c"), member("b"), member("a")] });

    expect(backward.additions).toEqual(forward.additions);
  });
});

describe("autoAssign: interpreter cover is a preference, never a gate", () => {
  it("prefers someone at the bar when the date has nobody at it", () => {
    const result = run({
      dateKeys: [D1],
      members: [
        member("low", { interpreterScore: 2 }),
        member("high", { interpreterScore: 5 }),
      ],
      cap: 1,
      interpreterBar: 5,
    });

    expect(result.additions).toEqual([{ dateKey: D1, memberId: "high" }]);
  });

  it("still fills a date when nobody meets the bar", () => {
    const result = run({
      dateKeys: [D1],
      members: [member("low", { interpreterScore: 1 })],
      cap: 1,
      interpreterBar: 5,
    });

    expect(result.additions).toHaveLength(1);
  });
});

describe("autoAssign: the diagnostics", () => {
  it("reports each date's fill against the cap", () => {
    const result = run({
      dateKeys: [D1],
      members: [member("a"), member("b")],
      cap: 5,
    });

    expect(result.dates.find((d) => d.dateKey === D1)).toMatchObject({
      available: 2,
      after: 2,
      cap: 5,
      shortBy: 3,
    });
  });

  it("reports what each member got against what they asked for", () => {
    const result = run({
      dateKeys: [D1, D2],
      members: [member("a", { requestedShifts: 2 })],
      cap: 5,
    });

    expect(result.members.find((m) => m.memberId === "a")).toMatchObject({
      requested: 2,
      after: 2,
    });
  });
});
