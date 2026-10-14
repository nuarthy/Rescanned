import { defineConfig } from 'vitest/config'

/**
 * The app config pulls in the TanStack Start plugin, which has no business
 * running for unit tests of the pure `lib` modules. This keeps tests fast.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
