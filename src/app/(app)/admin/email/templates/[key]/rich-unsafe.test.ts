import { describe, expect, it } from "vitest";
import { isRichUnsafe } from "./rich-unsafe";
import { getDescriptor } from "@/platform/email/templates/registry";

describe("isRichUnsafe", () => {
  it("locks a list wrapped around a raw slot to source mode", () => {
    expect(isRichUnsafe("<p>Hi</p><ul>{{{ memberRowsHtml }}}</ul>")).toBe(true);
    expect(isRichUnsafe('<ol class="x">\n  {{{ rows }}}\n</ol>')).toBe(true);
  });

  it("still locks tables and the layout", () => {
    expect(isRichUnsafe("<table><tr><td>x</td></tr></table>")).toBe(true);
    expect(isRichUnsafe("<p>x</p>", true)).toBe(true);
  });

  it("leaves ordinary bodies, including a raw slot outside a list, in rich mode", () => {
    expect(isRichUnsafe("<p>Hello {{ name }}</p><ul><li>Static item</li></ul>")).toBe(false);
    expect(isRichUnsafe("<p>Hi</p>{{{ additionalShifts }}}")).toBe(false);
  });

  it("covers the shipped list-rendering templates", () => {
    for (const key of ["shift-clearance-digest", "clearance-digest", "onboarding-reminder"]) {
      const d = getDescriptor(key);
      expect(d, key).toBeDefined();
      expect(isRichUnsafe(d!.defaultBody), key).toBe(true);
    }
  });
});
