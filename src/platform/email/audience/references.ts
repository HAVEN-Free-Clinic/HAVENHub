import type { AudienceNode } from "./types";
import { isAudienceGroup, CYCLE_VALUED_FIELD_KEYS } from "./types";

/**
 * The ids and codes a stored audience points at.
 *
 * The builder's option lists are built from what is CURRENTLY active
 * (departments, terms, recruitment cycles). A saved audience that names something
 * since deactivated or deleted would render as neither checked nor uncheckable
 * -- invisible in the UI while still serialising into every save and mailing that
 * group forever (#82). Callers union these referenced values into the option
 * lists so every stored value stays visible and, crucially, removable.
 */
export type AudienceReferences = {
  departmentCodes: Set<string>;
  cycleIds: Set<string>;
  /** Subcommittee ids named by a `subcommittee` condition's value. */
  subcommitteeIds: Set<string>;
  /** Term ids from the `terms` scope of any condition, whatever its field. */
  termIds: Set<string>;
};

function addValues(into: Set<string>, value: unknown) {
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === "string" && v) into.add(v);
  } else if (typeof value === "string" && value) {
    into.add(value);
  }
}

export function collectAudienceReferences(nodes: AudienceNode[]): AudienceReferences {
  const refs: AudienceReferences = {
    departmentCodes: new Set(),
    cycleIds: new Set(),
    subcommitteeIds: new Set(),
    termIds: new Set(),
  };

  (function walk(list: AudienceNode[]) {
    for (const node of list) {
      if (isAudienceGroup(node)) {
        walk(node.children);
        continue;
      }
      if (node.field === "department") addValues(refs.departmentCodes, node.value);
      // Every cycle-valued field feeds the same referenced-cycles set: the
      // cycle picker must keep a deleted cycle visible and removable no matter
      // which of them is the one still pointing at it. Read from the shared
      // list rather than an inline OR chain, so a field added to the registry
      // cannot be added here by hand and missed (see CYCLE_VALUED_FIELD_KEYS).
      if (CYCLE_VALUED_FIELD_KEYS.includes(node.field)) {
        addValues(refs.cycleIds, node.value);
      }
      if (node.field === "subcommittee") addValues(refs.subcommitteeIds, node.value);
      // Any condition may carry a term scope, so this is read unconditionally
      // rather than gated on the current TERM_SCOPED_FIELD_KEYS -- a stored
      // audience written against an earlier registry must not lose its scope.
      addValues(refs.termIds, node.terms);
    }
  })(nodes);

  return refs;
}
