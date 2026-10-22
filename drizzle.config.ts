import { defineConfig } from 'drizzle-kit';

// Generating migrations only compares the schema with drizzle/sqlite; it
// does not open a database. drizzle/postgres holds the frozen migrations
// the one-time Postgres import (src/db/import-postgres.ts) applies.
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle/sqlite',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_PATH ?? './data/cura.db' },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
