// @vitest-environment jsdom
/**
 * Audit 14 found Alert rendering a <p>. Three call sites had by then grown past a
 * single sentence and pass block children: the interview invite panel (a heading line
 * plus a copy-the-link row), and the two do-not-rehire notices (a heading line plus
 * detail lines). The HTML parser auto-closes an open <p> the moment a block element
 * starts inside it, so all of that content was hoisted OUT of the alert at parse time:
 * the bordered warning box rendered empty, and its text appeared below it, unstyled and
 * outside the element carrying role="status".
 *
 * That is a PARSER behaviour, not a React one, so asserting on the React tree would not
 * have caught it. These tests render to HTML and then hand the string to the real
 * document parser, which is the step the bug lived in.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Alert } from "./alert";

/** Server-render, then parse exactly as a browser would. */
function parse(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
}

describe("Alert with block children", () => {
  it("keeps a block child inside the alert box after parsing", () => {
    const host = parse(
      renderToStaticMarkup(
        <Alert tone="warning">
          <p className="font-medium">Copy this link now. It is not shown again.</p>
          <div data-testid="link-row">the link</div>
        </Alert>,
      ),
    );

    const box = host.querySelector('[role="status"]');
    expect(box).not.toBeNull();
    // The whole finding in one line: with a <p> wrapper both of these end up as
    // SIBLINGS of the box instead of descendants.
    expect(box!.querySelector('[data-testid="link-row"]')).not.toBeNull();
    expect(box!.textContent).toContain("Copy this link now.");
  });

  it("keeps a list inside the alert box after parsing", () => {
    const host = parse(
      renderToStaticMarkup(
        <Alert tone="error">
          <ul>
            <li data-testid="item">One reason</li>
          </ul>
        </Alert>,
      ),
    );

    const box = host.querySelector('[role="alert"]');
    expect(box!.querySelector('[data-testid="item"]')).not.toBeNull();
  });

  it("renders block content in an element that legally contains it", () => {
    const host = parse(renderToStaticMarkup(<Alert>text</Alert>));
    const box = host.querySelector('[role="status"]')!;
    expect(box.tagName).toBe("DIV");
    // The inner wrapper is the same trap one level down: a <div> inside a <span>
    // is invalid too, so it must not be a phrasing element either.
    expect(box.lastElementChild!.tagName).toBe("DIV");
  });
});

describe("Alert roles", () => {
  it("announces errors assertively and everything else politely", () => {
    const err = parse(renderToStaticMarkup(<Alert tone="error">boom</Alert>));
    expect(err.querySelector('[role="alert"]')).not.toBeNull();

    for (const tone of ["success", "warning", "info"] as const) {
      const host = parse(renderToStaticMarkup(<Alert tone={tone}>fine</Alert>));
      expect(host.querySelector('[role="status"]'), tone).not.toBeNull();
    }
  });

  it("lets a caller override the role", () => {
    const host = parse(renderToStaticMarkup(<Alert tone="error" role="status">quiet</Alert>));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });
});
