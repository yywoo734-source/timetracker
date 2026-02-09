import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};

function getAdapter() {
  if (process.env.NODE_ENV !== "production") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  if (!globalForPrisma.pool) {
    const ssl =
      process.env.NODE_ENV !== "production"
        ? {
            rejectUnauthorized: false,
          }
        : undefined;
    globalForPrisma.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
    });
  }
  return new PrismaPg(globalForPrisma.pool);
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: getAdapter(),
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
