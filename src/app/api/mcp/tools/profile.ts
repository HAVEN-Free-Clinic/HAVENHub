import { z } from "zod";
import { prisma } from "@/platform/db";
import type { McpTool } from "./index";
import { hubLink } from "./links";

/**
 * "What department am I in?" / "Am I a director?" -- and, more usefully, the
 * context Fin needs before it can reason about almost anything else a member
 * asks. Without it Fin has to guess whether the person is a volunteer or a
 * director, and which term they are onboarding for, from the wording of the
 * question.
 *
 * Self-scoped and input-free like every my_* tool: the caller is the verified
 * conversation's member, never a name the model supplies.
 *
 * Deliberately NOT included: contact details, date of birth, NetID, Epic
 * account id, photo -- anything beyond name, term, role, and department. The
 * member can read those on /my-info; there is no support question that needs
 * them rendered into a chat transcript.
 *
 * Reads the same membership set getPersonTerms does (ACTIVE memberships in
 * ACTIVE or PLANNING terms, live term first), inline rather than through it so
 * the department and kind come back in the same query.
 */
export const myProfileTool: McpTool = {
  name: "my_profile",
  title: "My profile",
  description:
    "Who the signed-in member is to the clinic: their name, and for the current and any upcoming term, which department(s) they belong to and whether they are a director or volunteer there. Use for questions like 'what department am I in?', 'am I a director?', 'am I on the roster for next term?', and call it first whenever the right answer depends on the member's role or department.",
  inputSchema: z.object({}),
  run: async (ctx) => {
    const [person, memberships] = await Promise.all([
      prisma.person.findUnique({ where: { id: ctx.personId }, select: { name: true } }),
      prisma.termMembership.findMany({
        where: { personId: ctx.personId, status: "ACTIVE", term: { status: { in: ["ACTIVE", "PLANNING"] } } },
        select: {
          kind: true,
          department: { select: { name: true } },
          term: { select: { id: true, name: true, status: true, startDate: true } },
        },
      }),
    ]);

    const who = person ? `You are signed in as ${person.name}.` : "You are signed in.";
    if (memberships.length === 0) {
      return `${who} You are not on the roster for the current or an upcoming term. Your record is at ${await hubLink("/my-info")}.`;
    }

    type Row = (typeof memberships)[number];
    const byTerm = new Map<string, { term: Row["term"]; roles: string[] }>();
    for (const m of memberships) {
      const entry = byTerm.get(m.term.id) ?? { term: m.term, roles: [] };
      entry.roles.push(`${m.kind === "DIRECTOR" ? "Director" : "Volunteer"} in ${m.department.name}`);
      byTerm.set(m.term.id, entry);
    }

    // Live term first, then upcoming terms soonest first -- the order a member
    // reads "this term, then next term" in.
    const terms = [...byTerm.values()].sort((a, b) => {
      if (a.term.status !== b.term.status) return a.term.status === "ACTIVE" ? -1 : 1;
      return a.term.startDate.getTime() - b.term.startDate.getTime();
    });
    const lines = terms.map(({ term, roles }) => {
      const when = term.status === "ACTIVE" ? "current term" : "upcoming term";
      return `${term.name} (${when}): ${roles.sort((a, b) => a.localeCompare(b)).join("; ")}.`;
    });

    return `${who} ${lines.join(" ")}`;
  },
};
