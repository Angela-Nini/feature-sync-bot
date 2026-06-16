import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().optional().default("127.0.0.1"),
  LARK_APP_ID: z.string().optional().default(""),
  LARK_APP_SECRET: z.string().optional().default(""),
  LARK_VERIFICATION_TOKEN: z.string().optional().default(""),
  LARK_ENCRYPT_KEY: z.string().optional().default(""),
  PLAN_SOURCE_OF_TRUTH_DOC: z.string().url().optional().default("https://zilliverse.feishu.cn/wiki/YQXxwvmJViX3YxkwvWVcguvgntU?from=from_copylink"),
  REGION_SOURCE_OF_TRUTH_DOC: z.string().url().optional().default("https://zilliverse.feishu.cn/wiki/VodrwqdGaiTxakk24rAcqw7LnIh?from=from_copylink"),
  DOCS_INDEX_BASE_TOKEN: z.string().optional().default("Ac7xbs2k1ad7bjsCXr0ccHe9nMh"),
  DOCS_INDEX_IDENTITY: z.enum(["bot", "user"]).optional().default("bot"),
  SOURCE_OF_TRUTH_FIXTURE_PATH: z.string().optional().default(""),
  PLAN_DOC_URL: z.string().url().optional().default("https://docs.zilliz.com/docs/select-zilliz-cloud-service-plans"),
  REGION_DOC_URL: z.string().url().optional().default("https://docs.zilliz.com/docs/cloud-providers-and-regions"),
  DOC_UPDATE_MODE: z.enum(["dry-run", "cli"]).optional().default("dry-run")
});

export const config = envSchema.parse(process.env);

export function assertFeishuApiConfig(): void {
  const missing = [
    ["LARK_APP_ID", config.LARK_APP_ID],
    ["LARK_APP_SECRET", config.LARK_APP_SECRET]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing Feishu config: ${missing.map(([key]) => key).join(", ")}`);
  }
}

export function assertFeishuEventConfig(): void {
  if (!config.LARK_VERIFICATION_TOKEN) {
    throw new Error("Missing Feishu config: LARK_VERIFICATION_TOKEN");
  }
}
