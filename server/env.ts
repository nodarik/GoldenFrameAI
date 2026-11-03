import { z } from "zod";

const schema = z.object({
  MODEL_API_KEY: z.string().min(10, "Set MODEL_API_KEY in .env (copy .env.example)"),
  META_BASE_URL: z.string().url().default("https://api.meta.ai/v1"),
  SPARK_MODEL: z.string().default("muse-spark-1.3"),
  WONDER_MODEL: z.string().default("muse-wonder-1.0"),
  SAM_MODEL: z.string().default("sam-3.1"),
  // Empty = no login (local development only). Always set it on a public deploy.
  ACCESS_CODE: z.string().default(""),
  // Not PORT: preview tools and hosts set PORT for the web dev server.
  API_PORT: z.coerce.number().int().default(8791),
  DATA_DIR: z.string().default("./data"),
  DAILY_SPEND_LIMIT_USD: z.coerce.number().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  for (const issue of parsed.error.issues) console.error(`Config error: ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
if (!env.ACCESS_CODE) console.warn("ACCESS_CODE is empty: the app has no login. Fine locally, never on a public URL.");
