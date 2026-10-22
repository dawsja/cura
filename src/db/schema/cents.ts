import { customType } from 'drizzle-orm/sqlite-core';

/**
 * A dollar amount stored as integer cents. SQLite has no exact decimal
 * type, so money is kept as whole cents in the database while app code
 * keeps reading and writing dollars (`12.34`), as it did with Postgres
 * `numeric(16,2)`. Values are rounded to the cent on write.
 */
export const dollarsAsCents = customType<{ data: number; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value) => Math.round(value * 100),
  fromDriver: (value) => Number(value) / 100,
});
