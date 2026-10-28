import { z } from 'zod';

export const BrowserConfigSchema=z.object({
  channel:z.enum(['chromium','msedge','chrome']).default('chromium'), executablePath:z.string().min(1).optional(),
  readySelector:z.string().min(1).max(200).optional(), navigationTimeoutMs:z.number().int().min(1).max(60_000).default(15_000),
  maxRequests:z.number().int().min(1).max(100).default(40),
}).strict();
export type BrowserConfig=z.infer<typeof BrowserConfigSchema>;
