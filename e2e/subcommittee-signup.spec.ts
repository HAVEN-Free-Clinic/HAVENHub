import { expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { prisma, tag } from "./fixtures";

/**
 * Subcommittee membership end to end: staff paste a lead in by email and open
 * sign-up, then a volunteer finds it under My info and joins.
 *
 * The seeded dev volunteer is on the active term's roster, which is what makes
 * them eligible to sign up.
 */
test("subcommittee: staff add a lead and open sign-up, a volunteer joins", async ({ browser }) => {
  const stamp = tag();
  const name = `Subcommittee ${stamp}`;
  const lead = await prisma.person.create({
    data: { name: `Lead ${stamp}`, contactEmail: `${stamp}-lead@example.com`, status: "ACTIVE" },
  });
  const sub = await prisma.subcommittee.create({
    data: { name, description: "Plans quality projects.", capacity: 5 },
  });

  const staffContext = await browser.newContext();
  const volunteerContext = await browser.newContext();
  try {
    const staff = await staffContext.newPage();
    await loginAs(staff, "admin");
    await staff.goto(`/recruitment/subcommittees/${sub.id}`);
    await staff.getByRole("textbox", { name: "Add people" }).fill(`${stamp}-lead@example.com\nnot-a-real-${stamp}`);
    await staff.getByRole("button", { name: "Add", exact: true }).click();
    await expect(staff.getByText(`Added Lead ${stamp}.`)).toBeVisible();
    await expect(staff.getByText(`No one in the Hub matches not-a-real-${stamp}`)).toBeVisible();

    // Open sign-up and save the settings form.
    await staff.getByLabel("Sign-up open").check();
    await staff.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await prisma.subcommittee.findUniqueOrThrow({ where: { id: sub.id } })).signupOpen)
      .toBe(true);

    const volunteer = await volunteerContext.newPage();
    await loginAs(volunteer, "volunteer");
    await volunteer.goto("/my-info/subcommittees");
    const card = volunteer.getByRole("region", { name });
    await expect(card.getByText(`Lead ${stamp}`)).toBeVisible();
    await expect(card.getByText("5 of 5 left")).toBeVisible();
    await card.getByRole("button", { name: "Join" }).click();
    await volunteer.waitForURL(/joined=1|\/my-info\/subcommittees$/);
    await expect(volunteer.getByRole("region", { name }).getByText("Joined")).toBeVisible();

    const members = await prisma.subcommitteeMembership.findMany({ where: { subcommitteeId: sub.id } });
    expect(members.map((m) => m.role).sort()).toEqual(["LEAD", "MEMBER"]);
  } finally {
    await staffContext.close();
    await volunteerContext.close();
    await prisma.subcommittee.delete({ where: { id: sub.id } }).catch(() => {});
    await prisma.person.delete({ where: { id: lead.id } }).catch(() => {});
  }
});
