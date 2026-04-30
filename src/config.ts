import { z } from "zod";

import { DEFAULT_SYSTEM_INSTRUCTION } from "./assistant/prompts.js";
import { ConfigurationError } from "./utils/errors.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .trim()
    .min(1, "TELEGRAM_ALLOWED_USER_IDS must include at least one Telegram user ID"),
  GEMINI_CLI_COMMAND: z.string().trim().min(1).default("gemini"),
  GEMINI_OUTPUT_FORMAT: z.enum(["json", "stream-json"]).default("json"),
  GEMINI_MODEL: z.string().trim().optional(),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  SESSION_STORE_PATH: z.string().trim().min(1).default(".data/sessions.json"),
  TELEGRAM_RESPONSE_CHUNK_SIZE: z.coerce.number().int().min(500).max(4096).default(3900),
  ASSISTANT_SYSTEM_INSTRUCTION: z.string().trim().optional()
});

export type GeminiOutputFormat = "json" | "stream-json";

export interface AppConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<string>;
  geminiCliCommand: string;
  geminiOutputFormat: GeminiOutputFormat;
  geminiModel?: string;
  geminiTimeoutMs: number;
  sessionStorePath: string;
  telegramResponseChunkSize: number;
  assistantSystemInstruction: string;
}

export function parseAllowedUserIds(value: string): ReadonlySet<string> {
  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new ConfigurationError("TELEGRAM_ALLOWED_USER_IDS must include at least one ID");
  }

  for (const id of ids) {
    if (!/^-?\d+$/.test(id)) {
      throw new ConfigurationError(`Invalid Telegram user ID in TELEGRAM_ALLOWED_USER_IDS: ${id}`);
    }
  }

  return new Set(ids);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new ConfigurationError(details);
  }

  const data = parsed.data;

  return {
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseAllowedUserIds(data.TELEGRAM_ALLOWED_USER_IDS),
    geminiCliCommand: data.GEMINI_CLI_COMMAND,
    geminiOutputFormat: data.GEMINI_OUTPUT_FORMAT,
    geminiModel: data.GEMINI_MODEL || undefined,
    geminiTimeoutMs: data.GEMINI_TIMEOUT_MS,
    sessionStorePath: data.SESSION_STORE_PATH,
    telegramResponseChunkSize: data.TELEGRAM_RESPONSE_CHUNK_SIZE,
    assistantSystemInstruction: data.ASSISTANT_SYSTEM_INSTRUCTION || DEFAULT_SYSTEM_INSTRUCTION
  };
}
