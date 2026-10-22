import { z } from 'zod';

/** Main category names: trimmed, 1–120 characters, no emoji (the UI draws its own icon). */
export const MainCategoryName = z.string().trim().min(1).max(120).refine(
  (name) => !/[\p{Extended_Pictographic}\p{Regional_Indicator}️⃣]/u.test(name),
  'Main category names cannot contain emoji',
);
