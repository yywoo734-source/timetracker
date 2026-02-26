import { PrismaClient } from "@/generated/prisma-new-app/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrismaNewApp = globalThis as unknown as {
  prismaNewApp?: PrismaClient;
  poolNewApp?: Pool;
};

function getAdapter() {
  if (process.env.NODE_ENV !== "production") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  if (!globalForPrismaNewApp.poolNewApp) {
    const ssl =
      process.env.NODE_ENV !== "production"
        ? {
            rejectUnauthorized: false,
          }
        : undefined;
    globalForPrismaNewApp.poolNewApp = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
    });
  }
  return new PrismaPg(globalForPrismaNewApp.poolNewApp);
}

export const prismaNewApp =
  globalForPrismaNewApp.prismaNewApp ??
  new PrismaClient({
    adapter: getAdapter(),
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrismaNewApp.prismaNewApp = prismaNewApp;
}
