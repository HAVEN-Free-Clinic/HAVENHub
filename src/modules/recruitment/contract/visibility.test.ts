import { describe, it, expect } from "vitest";
import { buildContractAnswers, visibleContractBlocks } from "./visibility";
import type { ContractBlock } from "./layout";

const agreement = (id: string, dept: string): ContractBlock => ({
  kind: "agreement", id, title: id, body: "", signatureLabel: "sign",
  confirmKind: "checkbox", visibleWhen: { field: "department", op: "is", value: dept },
});

const director = { department: "BVHD", track: "DIRECTOR" as const, epicRequirement: "ALL" as const };
const unplaced = { department: null, track: "VOLUNTEER" as const, epicRequirement: "NONE" as const };

describe("buildContractAnswers", () => {
  it("injects department, track and epicRequirement", () => {
    expect(buildContractAnswers({}, director))
      .toEqual({ department: "BVHD", track: "DIRECTOR", epicRequirement: "ALL" });
  });

  it("lets the authoritative department win over a form answer", () => {
    expect(buildContractAnswers({ department: "WRONG" }, director).department).toBe("BVHD");
  });

  it("omits department when there is none", () => {
    expect(buildContractAnswers({}, unplaced)).toEqual({ track: "VOLUNTEER", epicRequirement: "NONE" });
  });

  it("preserves unrelated form answers", () => {
    expect(buildContractAnswers({ hasEpic: "on" }, unplaced).hasEpic).toBe("on");
  });

  // Core invariant of this task: department, track and epicRequirement are
  // authoritative server-known facts (from the Acceptance, the cycle and the
  // department) and must never be overridable by a crafted form field of the
  // same name. A hostile applicant must not be able to relabel themselves as
  // a DIRECTOR, or claim ALL Epic access, by submitting `track` or
  // `epicRequirement` as an ordinary form answer.
  it("does not let a hostile form answer named track override the authoritative track", () => {
    const out = buildContractAnswers({ track: "DIRECTOR" }, unplaced);
    expect(out.track).toBe("VOLUNTEER");
  });

  it("does not let a hostile form answer named epicRequirement override the authoritative requirement", () => {
    const out = buildContractAnswers({ epicRequirement: "ALL" }, unplaced);
    expect(out.epicRequirement).toBe("NONE");
  });
});

describe("visibleContractBlocks", () => {
  it("keeps only the matching department block", () => {
    const blocks = [agreement("bvhd", "BVHD"), agreement("crad", "CRAD")];
    const answers = buildContractAnswers({}, director);
    expect(visibleContractBlocks(blocks, answers).map((b) => (b as { id: string }).id)).toEqual(["bvhd"]);
  });

  it("keeps blocks with no condition", () => {
    const blocks: ContractBlock[] = [{ kind: "section", id: "s", title: "S", body: "" }];
    expect(visibleContractBlocks(blocks, {})).toHaveLength(1);
  });

  it("drops every department block when the department is unknown", () => {
    const blocks = [agreement("bvhd", "BVHD")];
    const answers = buildContractAnswers({}, unplaced);
    expect(visibleContractBlocks(blocks, answers)).toHaveLength(0);
  });

  it("shows the Epic self report only for a SOME department", () => {
    const q: ContractBlock = {
      kind: "custom_question", key: "epic_needed_self", label: "Need Epic?",
      type: "SINGLE_SELECT", required: true,
      visibleWhen: { field: "epicRequirement", op: "is", value: "SOME" },
    };
    expect(visibleContractBlocks([q], buildContractAnswers({}, director))).toHaveLength(0);
    expect(visibleContractBlocks([q], buildContractAnswers({}, { ...director, epicRequirement: "SOME" }))).toHaveLength(1);
  });

  // The contract is a legal document read top to bottom: the order blocks
  // appear in must survive filtering, not just the membership of the result.
  it("preserves the order of the blocks it keeps", () => {
    const blocks: ContractBlock[] = [
      { kind: "section", id: "s1", title: "First", body: "" },
      { kind: "section", id: "s2", title: "Second", body: "", visibleWhen: { field: "track", op: "is", value: "NOWHERE" } },
      { kind: "section", id: "s3", title: "Third", body: "" },
      { kind: "section", id: "s4", title: "Fourth", body: "" },
    ];
    const kept = visibleContractBlocks(blocks, buildContractAnswers({}, director));
    expect(kept.map((b) => (b as { id: string }).id)).toEqual(["s1", "s3", "s4"]);
  });

  // Each condition operator is exercised end to end through
  // visibleContractBlocks (not just isFieldVisible/parseFieldCondition in
  // isolation), since this module is what the contract renderer actually
  // calls.
  describe("each condition operator filters blocks", () => {
    it("is: keeps the block only when the value matches", () => {
      const block: ContractBlock = {
        kind: "section", id: "s", title: "S", body: "",
        visibleWhen: { field: "department", op: "is", value: "BVHD" },
      };
      expect(visibleContractBlocks([block], buildContractAnswers({}, director))).toHaveLength(1);
      expect(visibleContractBlocks([block], buildContractAnswers({}, { ...director, department: "CRAD" }))).toHaveLength(0);
    });

    it("isNot: keeps the block only when the value does not match", () => {
      const block: ContractBlock = {
        kind: "section", id: "s", title: "S", body: "",
        visibleWhen: { field: "department", op: "isNot", value: "BVHD" },
      };
      expect(visibleContractBlocks([block], buildContractAnswers({}, director))).toHaveLength(0);
      expect(visibleContractBlocks([block], buildContractAnswers({}, { ...director, department: "CRAD" }))).toHaveLength(1);
    });

    it("isAnyOf: keeps the block when the value is any of the listed options", () => {
      const block: ContractBlock = {
        kind: "section", id: "s", title: "S", body: "",
        visibleWhen: { field: "department", op: "isAnyOf", value: ["BVHD", "CRAD"] },
      };
      expect(visibleContractBlocks([block], buildContractAnswers({}, director))).toHaveLength(1);
      expect(visibleContractBlocks([block], buildContractAnswers({}, { ...director, department: "JCTP" }))).toHaveLength(0);
    });

    it("isAnswered: keeps the block only when the form answer is present", () => {
      const block: ContractBlock = {
        kind: "section", id: "s", title: "S", body: "",
        visibleWhen: { field: "hasEpic", op: "isAnswered" },
      };
      expect(visibleContractBlocks([block], buildContractAnswers({}, director))).toHaveLength(0);
      expect(visibleContractBlocks([block], buildContractAnswers({ hasEpic: "on" }, director))).toHaveLength(1);
    });
  });

  // Fail open, matching isFieldVisible's documented contract: an
  // unparseable visibleWhen must not hide the block. If the layout somehow
  // stores a malformed condition, silently dropping the block would remove a
  // required agreement from a legal document without anyone noticing. Being
  // visible when it should not be is a much smaller problem than a signer
  // never being shown (and never signing) a required agreement.
  it("treats a block with a malformed visibleWhen as visible", () => {
    const block = {
      kind: "section", id: "s", title: "S", body: "",
      visibleWhen: { field: "department" }, // missing op: unparseable
    } as ContractBlock;
    expect(visibleContractBlocks([block], buildContractAnswers({}, unplaced))).toHaveLength(1);
  });
});
