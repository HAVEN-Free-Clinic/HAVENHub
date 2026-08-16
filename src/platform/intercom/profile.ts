import type { PersonStatus } from "@prisma/client";

/**
 * Member-context Intercom attributes carried on the Messenger JWT alongside
 * the audience booleans (see audience.ts) -- filled in from the live
 * Person/term/clearance state at mint time, keyed by the exact attribute
 * names already configured in the Intercom workspace (spaces and
 * capitalization included, same contract as HUB_AUDIENCE_ATTRIBUTES).
 *
 * A human agent answering a member in Intercom has no MCP access -- that is
 * Fin's interface, not theirs -- so without this an agent sees a name and
 * nothing else.
 *
 * departmentNames and activeTerm are pre-resolved by the caller (the
 * messenger-token route) rather than looked up here: this file lives in
 * src/platform, which must not import src/modules, and both department
 * membership and clearance are module-sourced (onboarding, terms). Passing
 * primitives in keeps this a pure, DB-free formatter.
 */
export type IntercomProfileInput = {
  epicId: string | null;
  netId: string | null;
  /** Active department memberships THIS TERM, already resolved by the caller. */
  departmentNames: string[];
  memberStatus: PersonStatus;
  /** Null when there is no active clinic term -- clearance does not apply without one. */
  activeTerm: { name: string; cleared: boolean } | null;
};

/**
 * Builds the profile attributes to merge onto the Intercom contact.
 *
 * Deliberately the OPPOSITE convention from buildAudienceAttributes: there,
 * every flag is sent every time, false included, because Intercom MERGES
 * attributes and an omitted flag would leave a revoked permission granted.
 * Here, an absent value is OMITTED rather than sent as null or empty,
 * because these attributes accumulate the Hub's best-known context about a
 * member rather than toggle a permission -- offboarding, for instance,
 * deliberately never clears Person.epicId (it stays as a historical record;
 * see epic.ts's completeRequest doc comment), so sending null here on a
 * boarding gap would erase something the Hub chose to keep. See jwt.ts's
 * mintIntercomUserJwt for where both rules are assembled side by side.
 */
export function buildProfileAttributes(input: IntercomProfileInput): Record<string, string> {
  const attrs: Record<string, string> = {
    // Person.status is a required, non-null column -- always present, unlike
    // every other attribute below.
    "Member status": input.memberStatus,
  };
  if (input.epicId) attrs["Epic ID"] = input.epicId;
  if (input.netId) attrs["Yale NetID"] = input.netId;
  if (input.departmentNames.length > 0) attrs["Departments"] = input.departmentNames.join(", ");
  if (input.activeTerm) {
    attrs["Active term"] = input.activeTerm.name;
    // Named "at last sign-in" deliberately, not "current" or "live": this is
    // a snapshot from the member's last Messenger boot, not a live read (the
    // JWT is only re-minted when the Messenger boots -- see jwt.ts's
    // INTERCOM_TOKEN_TTL_SECONDS doc comment). Do not rename it to something
    // cleaner -- the name is where an agent reads the caveat that a same-day
    // clearance change may not be reflected yet.
    attrs["Clearance at last sign-in"] = input.activeTerm.cleared ? "Cleared" : "Not cleared";
  }
  return attrs;
}
