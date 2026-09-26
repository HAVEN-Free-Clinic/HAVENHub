import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { Prisma } from "@prisma/client";
import { recordAudit } from "@/platform/audit";
import { getActivePerson } from "@/platform/auth/match-person";
import { can } from "@/platform/rbac/engine";
import { log, errorAttrs } from "@/platform/logging";
import { RECRUITMENT_RESOURCE, protectedResourceMetadataUrl, resourceUrl } from "@/platform/oauth/config";
import { publicOrigin } from "@/platform/oauth/origin";
import { verifyAccessToken } from "@/platform/oauth/tokens";
import { RECRUITMENT_TOOLS } from "./tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The recruitment MCP server: read-only recruitment data for one signed-in
 * staff member, called from Claude through a custom connector.
 *
 * Unlike /api/mcp (Fin, one shared bearer, identity from the Intercom
 * conversation), every request here carries an OAuth access token that names
 * exactly one person, issued after that person signed in to the Hub and
 * consented (src/platform/oauth). Every tool then runs as them, through the
 * same services and permission checks the recruitment pages use, so the
 * connector can never show someone more than the Hub already does.
 *
 * Three gates, in order, on every request:
 *   1. A valid, unexpired, unrevoked access token for THIS resource URL.
 *      Anything else is a 401 carrying the challenge Claude needs to start
 *      (or restart) sign-in.
 *   2. The person is still active. An offboarded member's tokens stop working
 *      at once rather than at expiry.
 *   3. recruitment.api_access is still held. Removing the grant cuts off a
 *      live connection on its next call, not in an hour.
 */

const TOOL_FAILURE_MESSAGE = "That lookup failed. Try again in a moment.";

const SERVER_INSTRUCTIONS = [
  "These tools read HAVEN Free Clinic recruitment data from the HAVEN Hub as the signed-in staff member, with exactly the access they have in the Hub.",
  "Start with list_cycles to find cycle ids. list_applicants is paginated: check `total` and page with `offset` before concluding anything about a whole cycle.",
  "Uploaded files are never available through these tools; point the person to the Hub for them.",
  "Applicant data is confidential. Do not repeat it outside this conversation's purpose.",
].join(" ");

function unauthorized(origin: string, description: string): Response {
  const metadata = protectedResourceMetadataUrl(origin, RECRUITMENT_RESOURCE);
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        // Claude only starts sign-in on a 401 with this header; the
        // resource_metadata pointer is how it finds the authorization server.
        "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metadata}", scope="${RECRUITMENT_RESOURCE.scope}"`,
      },
    },
  );
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? "";
}

function registerTools(server: McpServer, personId: string): void {
  for (const tool of RECRUITMENT_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const toolArgs = (args ?? {}) as Record<string, unknown>;
        let outcome: "ok" | "error" = "ok";
        let text: string;
        try {
          text = await tool.run({ personId }, toolArgs);
        } catch (err) {
          outcome = "error";
          log.error("[recruitment-mcp] tool call failed", errorAttrs(err, { tool: tool.name }));
          text = TOOL_FAILURE_MESSAGE;
        } finally {
          // One row per call, success or failure, so a connection's use can be
          // reconstructed after the fact. Opening an individual application
          // additionally writes the Hub's ordinary application-view entry from
          // inside the tool, so it shows up wherever those are read.
          await recordAudit({
            actorPersonId: personId,
            action: `recruitment_mcp.${outcome}`,
            entityType: "RecruitmentMcpToolCall",
            entityId: tool.name,
            after: { tool: tool.name, args: toolArgs } as Prisma.InputJsonValue,
          });
        }
        return { content: [{ type: "text" as const, text }] };
      },
    );
  }
}

async function handle(request: Request): Promise<Response> {
  const origin = publicOrigin(request.headers, request.url);
  const access = await verifyAccessToken(bearer(request), resourceUrl(origin, RECRUITMENT_RESOURCE));
  if (!access) return unauthorized(origin, "Sign in to the HAVEN Hub to use this connector");

  const person = await getActivePerson(access.personId);
  if (!person) return unauthorized(origin, "This Hub account is no longer active");

  if (!(await can(access.personId, RECRUITMENT_RESOURCE.permission))) {
    // A plain 403, deliberately without insufficient_scope: re-consenting
    // cannot fix a missing permission, so Claude should show an error rather
    // than loop through sign-in.
    return Response.json(
      { error: "access_denied", error_description: "Connecting apps to recruitment data is not enabled for this account." },
      { status: 403 },
    );
  }

  const handler = createMcpHandler((server) => registerTools(server, access.personId), {
    instructions: SERVER_INSTRUCTIONS,
  });
  return handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
