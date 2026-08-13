import { defineCollection, z } from 'astro:content';

/**
 * Minimal content collection for site metadata / future expansion.
 * Currently unused on the single-page mystic site, but ready for
 * Content Collections workflow.
 */
const meta = defineCollection({
  type: 'data',
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    image: z.string().url().optional(),
  }),
});

export const collections = { meta };
