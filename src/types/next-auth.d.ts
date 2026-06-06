import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    personId: string | null;
    user: DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    personId?: string | null;
  }
}
