/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/atlas/',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
