import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Person } from "@prisma/client";
import { config } from "@/platform/config";
import { resolvePersonForLogin, type LoginProfile } from "./match-person";

type EntraClaims = {
  oid?: string;
  tid?: string;
  preferred_username?: string;
  email?: string;
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
  session: { strategy: "jwt" },
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
    // Dev-only login: email lookup, no password. Never registered in production.
    ...(config.NODE_ENV !== "production"
      ? [
          Credentials({
            id: "credentials",
            name: "Dev Login",
            credentials: { email: { label: "Email", type: "text" } },
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
    async signIn({ user, account, profile }) {
      if (account?.provider === "credentials") return true; // authorize() validated
      const person = await resolveEntraLogin(
        profile,
        account?.providerAccountId,
        user.email
      );
      return person ? true : "/welcome";
    },
    async jwt({ token, user, account, profile }) {
      if (account) {
        // Initial sign-in only
        if (account.provider === "credentials" && user) {
          token.personId = user.id;
        } else {
          const person = await resolveEntraLogin(
            profile,
            account.providerAccountId,
            user?.email
          );
          token.personId = person?.id ?? null;
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.personId = (token.personId as string | null) ?? null;
      return session;
    },
  },
});
