import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Person } from "@prisma/client";
import { config } from "@/platform/config";
import {
  resolvePersonForLogin,
  applicantEmailFromClaims,
  firstNameFromClaims,
  entraTenantAllowed,
  type LoginProfile,
} from "./match-person";
import { recordAudit } from "@/platform/audit";
import { getPostHogClient } from "@/platform/posthog/posthog-server";

type EntraClaims = {
  oid?: string;
  tid?: string;
  preferred_username?: string;
  email?: string;
  given_name?: string;
  name?: string;
};

function profileFromEntra(
  profile: unknown,
  providerAccountId: string | undefined,
  fallbackEmail: string | null | undefined
): LoginProfile {
  const claims = (profile ?? {}) as EntraClaims;
  return {
    entraObjectId: claims.oid ?? providerAccountId ?? null,
    upn: claims.preferred_username ?? null,
    email: claims.email ?? fallbackEmail ?? null,
  };
}

/** The signIn-callback side of match-person's security contract. */
async function resolveEntraLogin(
  profile: unknown,
  providerAccountId: string | undefined,
  fallbackEmail: string | null | undefined
): Promise<Person | null> {
  const claims = (profile ?? {}) as EntraClaims;
  // Tenant check: the tenant-specific issuer already constrains this, but be explicit.
  if (config.AZURE_AD_TENANT_ID && claims.tid && claims.tid !== config.AZURE_AD_TENANT_ID) {
    return null;
  }
  const person = await resolvePersonForLogin(
    profileFromEntra(profile, providerAccountId, fallbackEmail)
  );
  if (!person || person.status === "OFFBOARDED") return null;
  return person;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: config.AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // 7 days
  providers: [
    ...(config.AZURE_AD_CLIENT_ID
      ? [
          MicrosoftEntraID({
            clientId: config.AZURE_AD_CLIENT_ID,
            clientSecret: config.AZURE_AD_CLIENT_SECRET!,
            issuer: `https://login.microsoftonline.com/${config.AZURE_AD_TENANT_ID}/v2.0`,
          }),
        ]
      : []),
    // Email-only login (no password): the dev convenience login. Registered
    // outside production, or in a DEMO_MODE deploy that has no Azure AD app.
    ...(config.NODE_ENV !== "production" || config.DEMO_MODE
      ? [
          Credentials({
            id: "credentials",
            name: "Dev Login",
            credentials: { email: { label: "Email", type: "text" } },
            // Note: matching applies the same Yale-claim gate as prod, so dev login works only with @yale.edu emails (or netId/oid matches).
            async authorize(credentials) {
              const email = credentials?.email as string | undefined;
              if (!email) return null;
              const person = await resolvePersonForLogin({ email });
              if (!person || person.status !== "ACTIVE") return null;
              return { id: person.id, email, name: person.name };
            },
          }),
        ]
      : []),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "credentials") return true; // authorize() validated
      // Admit any Yale-tenant account. Recognized members get a personId in jwt();
      // everyone else becomes a prospective applicant (personId null). Hub access
      // stays gated by requirePersonSession, so this only unlocks the apply portal.
      const claims = (profile ?? {}) as EntraClaims;
      return entraTenantAllowed(claims, config.AZURE_AD_TENANT_ID);
    },
    async jwt({ token, user, account, profile }) {
      if (account) {
        // Initial sign-in only
        let personId: string | null = null;
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
          personId = user.id ?? null;
        } else {
          const claims = (profile ?? {}) as EntraClaims;
          const person = await resolveEntraLogin(
            profile,
            account.providerAccountId,
            user?.email
          );
          token.personId = person?.id ?? null;
          personId = person?.id ?? null;
          // Verified Yale address, stamped whether or not we recognize the Person,
          // so the apply portal can identify a brand-new applicant by email.
          token.applicantEmail = applicantEmailFromClaims(claims, user?.email);
          // First name from the Entra sign-in, so the portal can greet a brand-new
          // applicant (no Person yet) by name instead of their email local part.
          token.applicantFirstName = firstNameFromClaims(claims);
          if (!person) {
            await recordAudit({
              action: "auth.applicant_login",
              entityType: "Auth",
              after: {
                upn: claims.preferred_username ?? null,
                email: token.applicantEmail as string | null,
              },
            });
          }
        }
        if (personId) {
          const posthog = getPostHogClient();
          posthog.capture({
            distinctId: personId,
            event: "user_signed_in",
            properties: { provider: account.provider },
          });
          await posthog.flush();
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.personId = (token.personId as string | null) ?? null;
      session.applicantEmail = (token.applicantEmail as string | null) ?? null;
      session.applicantFirstName = (token.applicantFirstName as string | null) ?? null;
      return session;
    },
  },
});
