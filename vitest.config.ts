import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Интеграционные тесты делят одну БД и очищают её — файлы идут последовательно.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', fileParallelism: false },
});
