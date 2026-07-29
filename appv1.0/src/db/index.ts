import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverEnv } from "@/lib/env";
import * as schema from "./schema";

const queryClient = postgres(serverEnv.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });

export * from "./schema";
