import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterBar, FilterField } from "./filter-bar";
import { FormRow, RowField, ROW_WIDTH } from "./form";
import { Input } from "./input";

// NavForm is a client component reading router hooks; stub them for SSR.
vi.mock("next/navigation", () => ({
  usePathname: () => "/volunteers/master",
  useRouter: () => ({ push: () => {} }),
}));

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe("FilterBar", () => {
  it("submits through an outline button, not a brand-filled one", () => {
    // Filtering refines what is already on screen. Four pages rendered this
    // primary, which is what stops brand fill reading as "do this".
    const out = render(
      <FilterBar>
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(out).toContain("Filter");
    expect(out).not.toContain("bg-brand");
  });

  it("labels every control visibly, not with aria-label alone", () => {
    const out = render(
      <FilterBar>
        <FilterField label="Department">
          <Input name="departmentId" />
        </FilterField>
      </FilterBar>,
    );
    // The label is real text in a <label>, so a sighted user sees it too.
    expect(out).toContain("Department");
    expect(out).toContain("<label");
  });

  it("offers Clear only when a filter is applied", () => {
    const withFilter = render(
      <FilterBar clearHref="/volunteers/master">
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(withFilter).toContain("Clear");
    expect(withFilter).toContain('href="/volunteers/master"');

    const clean = render(
      <FilterBar>
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(clean).not.toContain("Clear");
  });

  it("renders Clear as a link, since clearing is a navigation", () => {
    const out = render(
      <FilterBar clearHref="/x">
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    const clearAnchor = out.slice(out.indexOf('href="/x"'));
    expect(clearAnchor.startsWith('href="/x"')).toBe(true);
    expect(out).toContain("<a ");
  });

  it("keeps the GET form shape so the bar still works without JS", () => {
    const out = render(
      <FilterBar action="/admin/people">
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(out).toContain('method="GET"');
    expect(out).toContain('action="/admin/people"');
  });

  it("takes outer spacing but keeps its own row layout", () => {
    const out = render(
      <FilterBar className="mt-6">
        <FilterField label="Search">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(out).toContain("mt-6");
    expect(out).toContain("flex flex-wrap items-end gap-3");
  });

  it("gives each width role one class, so pages stop picking their own", () => {
    const grow = render(
      <FilterBar>
        <FilterField label="Search" width="grow">
          <Input name="q" />
        </FilterField>
      </FilterBar>,
    );
    expect(grow).toContain("flex-1 min-w-48");

    const wide = render(
      <FilterBar>
        <FilterField label="Department" width="wide">
          <Input name="d" />
        </FilterField>
      </FilterBar>,
    );
    expect(wide).toContain(ROW_WIDTH.wide);
  });

  it("draws its widths from the same table the write forms use", () => {
    // A Department select in a filter row and a Department select in the write
    // form above it are the same control doing the same job, one above the
    // other on /incidents/strikes. Two width tables is how they drift apart.
    const filter = render(
      <FilterBar>
        <FilterField label="Department" width="wide">
          <Input name="d" />
        </FilterField>
      </FilterBar>,
    );
    const write = render(
      <FormRow>
        <RowField label="Department" width="wide">
          <Input name="d" />
        </RowField>
      </FormRow>,
    );
    const widthOf = (html: string) => /class="(w-\d+|flex-1[^"]*)"/.exec(html)?.[1];
    expect(widthOf(filter)).toBe(widthOf(write));
    expect(widthOf(filter)).toBeDefined();
  });
});
