import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/domains/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.types.ts', '**/*.schemas.ts', '**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    pool: 'threads',
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
