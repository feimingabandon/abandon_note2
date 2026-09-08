import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,ts}'],
    exclude: ['tmp/**', 'out/**', 'dist*/**', 'node_modules/**']
  }
})
