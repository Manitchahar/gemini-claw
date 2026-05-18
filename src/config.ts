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
  GEMINI_OUTPUT_FORMAT: z.enum(["json", "stream-json"]).default("stream-json"),
  GEMINI_MODEL: z.string().trim().optional(),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GEMINI_APPROVAL_MODE: z.string().trim().optional(),
  GEMINI_SANDBOX: z.string().optional(),
  GEMINI_DEBUG: z.string().optional(),
  GEMINI_TRUST_WORKSPACE: z.string().optional(),
  GEMINI_CWD: z.string().trim().optional(),
  GEMINI_ALLOWED_TOOLS: z.string().optional(),
  GEMINI_ALLOWED_MCP_SERVER_NAMES: z.string().optional(),
  GEMINI_EXTENSIONS: z.string().optional(),
  GEMINI_INCLUDE_DIRECTORIES: z.string().optional(),
  GEMINI_SETTINGS: z.string().trim().optional(),
  GEMINI_RESUME_SESSIONS: z.string().optional(),
  GEMINI_MAX_WORKERS: z.coerce.number().int().positive().default(3),
  GEMINI_MAX_CHAT_WORKERS: z.coerce.number().int().positive().default(3),
  GEMINI_MAX_QUEUED_TASKS: z.coerce.number().int().positive().default(50),
  GEMINI_MAX_CHAT_QUEUED_TASKS: z.coerce.number().int().positive().default(10),
  GEMINI_TASK_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  GEMINI_WORKER_SESSION_MODE: z.enum(["isolated", "chat"]).default("isolated"),
  OPERATOR_LOG_STYLE: z.enum(["pretty", "plain", "json"]).default("pretty"),
  OPERATOR_LOG_LEVEL: z.enum(["silent", "info", "debug"]).default("info"),
  OPERATOR_LOG_CONTENT: z.string().optional(),
  OPERATOR_LOG_PREVIEW_CHARS: z.coerce.number().int().positive().default(120),
  SESSION_STORE_PATH: z.string().trim().min(1).default(".data/sessions.json"),
  TASK_STORE_PATH: z.string().trim().min(1).default(".data/tasks.json"),
  TELEGRAM_RESPONSE_CHUNK_SIZE: z.coerce.number().int().min(500).max(4096).default(3900),
  ASSISTANT_SYSTEM_INSTRUCTION: z.string().trim().optional()
});

export type GeminiOutputFormat = "json" | "stream-json";
export type GeminiWorkerSessionMode = "isolated" | "chat";
export type OperatorLogStyle = "pretty" | "plain" | "json";
export type OperatorLogLevel = "silent" | "info" | "debug";

export interface AppConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<string>;
  geminiCliCommand: string;
  geminiOutputFormat: GeminiOutputFormat;
  geminiModel?: string;
  geminiTimeoutMs: number;
  geminiYolo: boolean;
  geminiApprovalMode?: string;
  geminiSandbox: boolean;
  geminiDebug: boolean;
  geminiTrustWorkspace: boolean;
  geminiCwd?: string;
  geminiAllowedTools: string[];
  geminiAllowedMcpServerNames: string[];
  geminiExtensions: string[];
  geminiIncludeDirectories: string[];
  geminiSettings?: string;
  geminiResumeSessions: boolean;
  geminiMaxWorkers: number;
  geminiMaxChatWorkers: number;
  geminiMaxQueuedTasks: number;
  geminiMaxChatQueuedTasks: number;
  geminiTaskHistoryLimit: number;
  geminiWorkerSessionMode: GeminiWorkerSessionMode;
  operatorLogStyle: OperatorLogStyle;
  operatorLogLevel: OperatorLogLevel;
  operatorLogContent: boolean;
  operatorLogPreviewChars: number;
  sessionStorePath: string;
  taskStorePath: string;
  telegramResponseChunkSize: number;
  assistantSystemInstruction: string;
}

export function parseBooleanConfig(value: string | undefined, name: string, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      throw new ConfigurationError(`${name} must be a boolean value (true/false, 1/0, yes/no, on/off)`);
  }
}

export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
    geminiYolo: true,
    geminiApprovalMode: data.GEMINI_APPROVAL_MODE || undefined,
    geminiSandbox: parseBooleanConfig(data.GEMINI_SANDBOX, "GEMINI_SANDBOX"),
    geminiDebug: parseBooleanConfig(data.GEMINI_DEBUG, "GEMINI_DEBUG"),
    geminiTrustWorkspace: parseBooleanConfig(data.GEMINI_TRUST_WORKSPACE, "GEMINI_TRUST_WORKSPACE", true),
    geminiCwd: data.GEMINI_CWD || undefined,
    geminiAllowedTools: parseCommaSeparatedList(data.GEMINI_ALLOWED_TOOLS),
    geminiAllowedMcpServerNames: parseCommaSeparatedList(data.GEMINI_ALLOWED_MCP_SERVER_NAMES),
    geminiExtensions: parseCommaSeparatedList(data.GEMINI_EXTENSIONS),
    geminiIncludeDirectories: parseCommaSeparatedList(data.GEMINI_INCLUDE_DIRECTORIES),
    geminiSettings: data.GEMINI_SETTINGS || undefined,
    geminiResumeSessions: parseBooleanConfig(data.GEMINI_RESUME_SESSIONS, "GEMINI_RESUME_SESSIONS", true),
    geminiMaxWorkers: data.GEMINI_MAX_WORKERS,
    geminiMaxChatWorkers: data.GEMINI_MAX_CHAT_WORKERS,
    geminiMaxQueuedTasks: data.GEMINI_MAX_QUEUED_TASKS,
    geminiMaxChatQueuedTasks: data.GEMINI_MAX_CHAT_QUEUED_TASKS,
    geminiTaskHistoryLimit: data.GEMINI_TASK_HISTORY_LIMIT,
    geminiWorkerSessionMode: data.GEMINI_WORKER_SESSION_MODE,
    operatorLogStyle: data.OPERATOR_LOG_STYLE,
    operatorLogLevel: data.OPERATOR_LOG_LEVEL,
    operatorLogContent: parseBooleanConfig(data.OPERATOR_LOG_CONTENT, "OPERATOR_LOG_CONTENT"),
    operatorLogPreviewChars: data.OPERATOR_LOG_PREVIEW_CHARS,
    sessionStorePath: data.SESSION_STORE_PATH,
    taskStorePath: data.TASK_STORE_PATH,
    telegramResponseChunkSize: data.TELEGRAM_RESPONSE_CHUNK_SIZE,
    assistantSystemInstruction: data.ASSISTANT_SYSTEM_INSTRUCTION || DEFAULT_SYSTEM_INSTRUCTION
  };
}
