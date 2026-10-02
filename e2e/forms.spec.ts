import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, tag } from "./fixtures";

/**
 * Forms end to end: staff create a form from the recruitment-feedback
 * template, open it and assign the seeded volunteer by email; the volunteer
 * finds it under My info, answers the required questions and submits; staff
 * see the response counted and summarized.
 */
test("forms: create from a template, assign, fill out, read results", async ({ browser }) => {
  const title = `Recruitment feedback ${tag()}`;
  const staffContext = await browser.newContext();
  const volunteerContext = await browser.newContext();
  let formId: string | null = null;
  try {
    const staff = await staffContext.newPage();
    await loginAs(staff, "admin");
    await staff.goto("/forms/new");
    await staff.getByRole("radio", { name: /Volunteer recruitment feedback/ }).check();
    await staff.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await staff.getByRole("button", { name: "Create form" }).click();
    // Not /forms\/[a-z0-9]+$/ alone: that already matches /forms/new.
    await staff.waitForURL(/\/forms\/(?!new$)[a-z0-9]+$/);
    formId = staff.url().split("/").pop() ?? null;
    await expect(staff.getByRole("heading", { level: 1, name: title })).toBeVisible();

    await staff.getByRole("button", { name: "Open for responses" }).click();
    await expect(staff.getByText("Open", { exact: true }).first()).toBeVisible();

    await staff.goto(`/forms/${formId}?tab=assign`);
    await staff.getByRole("textbox", { name: "NetIDs or emails" }).fill("dev.volunteer@yale.edu");
    await staff.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(staff.getByText(/Assigned 1 person/)).toBeVisible();

    const volunteer = await volunteerContext.newPage();
    await loginAs(volunteer, "volunteer");
    await volunteer.goto("/my-info/forms");
    await volunteer.getByRole("link", { name: title }).click();
    await volunteer.waitForURL(/\/my-info\/forms\/[a-z0-9]+$/);

    // The required questions of the template.
    await volunteer.getByRole("checkbox", { name: "Info session" }).check();
    await volunteer.getByRole("radio", { name: "No, this was my first time" }).check();
    const agreeGroups = [
      "The application questions were clear.",
      "I had enough information about the departments to choose the right one for me.",
      "I heard back about my decision in a reasonable amount of time.",
      "After I was accepted, I knew what I needed to do before my first shift (contract, HIPAA, trainings).",
    ];
    for (const legend of agreeGroups) {
      await volunteer.getByRole("group", { name: new RegExp(legend.replace(/[.()]/g, "\\$&")) }).getByRole("radio", { name: "Agree", exact: true }).check();
    }
    await volunteer.getByRole("group", { name: /Did you have an interview/ }).getByRole("radio", { name: "No" }).check();
    await volunteer.getByRole("group", { name: /How clear was communication/ }).getByRole("radio", { name: "4" }).check();
    await volunteer.getByRole("group", { name: /Overall, how satisfied/ }).getByRole("radio", { name: "5" }).check();
    await volunteer.getByRole("textbox", { name: /What went well/ }).fill("Smooth interviews and quick decisions.");
    await volunteer.getByRole("button", { name: "Submit" }).click();
    await volunteer.waitForURL(/submitted=1|\/my-info\/forms\/[a-z0-9]+$/);
    await expect(volunteer.getByText(/You responded on/)).toBeVisible();

    await staff.goto(`/forms/${formId}?tab=responses`);
    await expect(staff.getByText("1 response")).toBeVisible();
    // Once in the summary and once inside the (collapsed) individual response.
    await expect(staff.getByText("Smooth interviews and quick decisions.").first()).toBeVisible();
    await expect(staff.getByText(/average 5\.0 of 5/)).toBeVisible();
  } finally {
    await staffContext.close();
    await volunteerContext.close();
    if (formId) await prisma.form.delete({ where: { id: formId } }).catch(() => {});
  }
});
