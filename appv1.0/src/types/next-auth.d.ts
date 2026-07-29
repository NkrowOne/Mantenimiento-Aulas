import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role: "operador" | "lector";
    mustChangePassword: boolean;
  }

  interface Session {
    user: {
      id: string;
      role: "operador" | "lector";
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: "operador" | "lector";
    mustChangePassword?: boolean;
  }
}
