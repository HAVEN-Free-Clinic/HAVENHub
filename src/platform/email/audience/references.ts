import type { AudienceNode } from "./types";
import { isAudienceGroup } from "./types";

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
    termIds: new Set(),
  };

  (function walk(list: AudienceNode[]) {
    for (const node of list) {
      if (isAudienceGroup(node)) {
        walk(node.children);
        continue;
      }
      if (node.field === "department") addValues(refs.departmentCodes, node.value);
      if (node.field === "appliedToCycle") addValues(refs.cycleIds, node.value);
      // Any condition may carry a term scope, so this is read unconditionally
      // rather than gated on the current TERM_SCOPED_FIELD_KEYS -- a stored
      // audience written against an earlier registry must not lose its scope.
      addValues(refs.termIds, node.terms);
    }
  })(nodes);

  return refs;
}
