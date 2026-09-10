/**
 * These assertions are construction-green: nothing here could fail against a
 * component that did not exist before this commit. What they buy is the future
 * -- the defect this component closes was two views of ONE page rendering the
 * same person's Director chip in two different tones, and the only way that
 * comes back is if a tone stops being a function of `kind` alone. That is what
 * these pin. The swap of the six call sites is guarded by the diff, not here.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BADGE_TONE_CLASSES } from "./badge";
import { MembershipKindBadge, membershipKindLabel } from "./membership-kind-badge";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("MembershipKindBadge", () => {
  it("gives a director the brand tone and a volunteer the default one", () => {
    const director = render(<MembershipKindBadge kind="DIRECTOR" />);
    expect(director).toContain("Director");
    expect(director).toContain(BADGE_TONE_CLASSES.brand);

    const volunteer = render(<MembershipKindBadge kind="VOLUNTEER" />);
    expect(volunteer).toContain("Volunteer");
    expect(volunteer).toContain(BADGE_TONE_CLASSES.default);
  });

  it("gives the two kinds different tones, which is the drift that started this", () => {
    // The schedule builder's Day view drew this chip brand and its Availability
    // view drew it default, for the same person on the same page.
    //
    // Asserted by RENDERING both kinds and comparing them. The version this
    // replaces compared two entries of BADGE_TONE_CLASSES to each other and then
    // looked for `class="<default>"`, which no Badge ever emits: Badge composes
    // its base classes in front of the tone, so the literal never appears at any
    // tone. Collapsing the component to a single tone left it green.
    const director = render(<MembershipKindBadge kind="DIRECTOR" />);
    const volunteer = render(<MembershipKindBadge kind="VOLUNTEER" />);
    expect(director).toContain(BADGE_TONE_CLASSES.brand);
    expect(volunteer).toContain(BADGE_TONE_CLASSES.default);
    expect(director).not.toContain(BADGE_TONE_CLASSES.default);
    expect(volunteer).not.toContain(BADGE_TONE_CLASSES.brand);
  });

  it("abbreviates the word only, never the tone", () => {
    // The builder grid's ~52px columns take "Dir"/"Vol". If shortening the text
    // also changed the colour, the grid would be a sixth rendering again.
    const long = render(<MembershipKindBadge kind="DIRECTOR" />);
    const short = render(<MembershipKindBadge kind="DIRECTOR" abbreviated />);
    expect(short).toContain("Dir");
    expect(short).not.toContain("Director");
    expect(short).toContain(BADGE_TONE_CLASSES.brand);
    expect(short.replace(">Dir<", ">Director<")).toBe(long);

    const shortVol = render(<MembershipKindBadge kind="VOLUNTEER" abbreviated />);
    expect(shortVol).toContain("Vol");
    expect(shortVol).toContain(BADGE_TONE_CLASSES.default);
  });

  it("labels prose with the same word the chip renders", () => {
    // /volunteers/directory names a person's other seats in running text. One
    // source for the word, so the line and the chip cannot disagree.
    expect(render(<MembershipKindBadge kind="DIRECTOR" />)).toContain(
      `>${membershipKindLabel("DIRECTOR")}<`,
    );
    expect(render(<MembershipKindBadge kind="VOLUNTEER" />)).toContain(
      `>${membershipKindLabel("VOLUNTEER")}<`,
    );
  });
});
