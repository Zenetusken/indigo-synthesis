import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/platform/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://indigo:development-only@127.0.0.1:5432/indigo_synthesis',
  },
  strict: true,
  verbose: true,
})
