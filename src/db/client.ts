import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

/** Prisma 7: подключение идёт через драйверный адаптер (node-postgres). */
export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
