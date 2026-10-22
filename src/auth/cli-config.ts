/**
 * Entry point for the Better Auth CLI (`bun run db:generate`), which loads a
 * module that exports an `auth` instance and writes src/db/schema/auth.ts.
 * The app itself builds its instance through ./instance.ts.
 */
import { createAuth } from './config';

export const auth = createAuth([]);
