import 'dotenv/config'; // локальная разработка: подхватывает .env (в Docker переменные задаёт compose)
import { defineConfig } from 'prisma/config';

// Prisma 7: адрес БД для CLI (миграции) задаётся здесь, а не в schema.prisma.
// Для `prisma generate` подключение не нужно, поэтому при отсутствии переменной берём заглушку.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder' },
});
