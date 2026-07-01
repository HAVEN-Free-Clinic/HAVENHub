import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { seedCourseWithPackage } from "./fixtures";

let course: Awaited<ReturnType<typeof seedCourseWithPackage>>;

test.beforeEach(async () => {
  course = await seedCourseWithPackage({ deptCode: "ITCM" });
});

test.afterEach(async () => {
  await course?.cleanup();
});

/**
 * The admin has a DIRECTOR TermMembership in ITCM and the Platform Admin role
 * (which exempts them from the onboarding gate). The fixture course is scoped to
 * ITCM (not org-wide), so it is assigned to the admin and appears in their catalog
 * while leaving the VADM dev users ungated. /learning/manage lists all courses.
 */
test("learning: assigned course appears in the catalog and is openable", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/learning");

  // Course title is rendered as a span inside a Link card.
  await expect(page.getByText(course.course.title)).toBeVisible();

  // Click the link wrapping the course card.
  await page.locator("a").filter({ hasText: course.course.title }).click();

  // Should land on the course player page.
  await expect(page).toHaveURL((url) => url.pathname.includes("/learning/"));

  // The fixture sets scormEntryHref but no scormScos, so the enrollment service
  // synthesizes a single SCO from scormEntryHref. ScormPlayer renders an iframe
  // titled "Course content" for that SCO. The iframe DOM element is present even
  // though the SCORM content files are not on disk.
  await expect(page.locator('iframe[title="Course content"]')).toBeVisible();
});

test("learning manage: course shows in the management list", async ({ page }) => {
  await loginAs(page, "admin");
  await page.goto("/learning/manage");

  // The manage list renders all courses regardless of assignment or membership.
  await expect(page.getByText(course.course.title)).toBeVisible();
});
