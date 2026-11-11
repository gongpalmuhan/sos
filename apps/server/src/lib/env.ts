import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Operator fine-grained token: Contents / Issues / Pull requests read-only. */
  GITHUB_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  AI_MODEL_DEFAULT: z.string().default('gpt-6-luna'),
  AI_MODEL_FALLBACK: z.string().default('gpt-6.1-sol'),
  AI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** USD per 1M tokens, "input,output" — used for cost estimates only. */
  AI_PRICE_DEFAULT: z.string().default('0,0'),
  AI_PRICE_FALLBACK: z.string().default('0,0'),
  AI_PRICE_EMBEDDING: z.string().default('0'),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  /** Allowed browser origins for the separate client app (comma separated). */
  CORS_ORIGINS: z.string().default(''),
  /** Where to send the user after OAuth callback. */
  APP_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated env. Throws a descriptive error listing missing variables. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid server environment: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function parsePrice(value: string): { input: number; output: number } {
  const [i = '0', o = '0'] = value.split(',');
  return { input: Number(i) || 0, output: Number(o) || 0 };
}
