export type OperatorLogLevel = "silent" | "info" | "debug";
export type OperatorLogStyle = "pretty" | "plain" | "json";

export interface OperatorLoggerOptions {
  level: OperatorLogLevel;
  style: OperatorLogStyle;
  includeContent: boolean;
  previewChars: number;
  write?: (line: string) => void;
}

export interface OperatorLogger {
  readonly includeContent: boolean;
  preview(value: string | undefined): string | undefined;
  banner(fields: Record<string, LogValue>): void;
  info(event: string, fields?: Record<string, LogValue>): void;
  debug(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, fields?: Record<string, LogValue>): void;
}

export type LogValue = string | number | boolean | undefined | null | readonly string[];
type LogSeverity = "info" | "debug" | "error";

const icons: Record<string, string> = {
  startup: "╭─",
  chat_request: "📨",
  chat_reply: "📤",
  chat_error: "💥",
  task_queued: "🚀",
  task_running: "⚙️",
  task_completed: "✅",
  task_failed: "💥",
  task_cancelled: "🛑",
  task_rejected: "⛔",
  command: "⌘",
  gemini_start: "🧠",
  gemini_done: "✨",
  gemini_error: "⚠️",
  tool_start: "🔧",
  tool_end: "✅",
  subagent: "🤖",
  reset: "♻️"
};

export function createOperatorLogger(options: OperatorLoggerOptions): OperatorLogger {
  const write = options.write ?? ((line: string) => console.log(line));

  const logger: OperatorLogger = {
    includeContent: options.includeContent,
    preview(value) {
      return previewText(value, options.previewChars, options.includeContent);
    },
    banner(fields) {
      if (options.level === "silent") return;

      if (options.style === "json") {
        writeJson(write, "startup", "info", fields);
        return;
      }

      if (options.style === "plain") {
        write(formatPlain("startup", "info", fields));
        return;
      }

      const bot = formatValue(fields.bot) ?? "unknown";
      const mode = formatValue(fields.mode) ?? "default";
      const workers = formatValue(fields.workers) ?? "0/0";
      const model = formatValue(fields.model) ?? "Gemini CLI default";
      const sessions = formatValue(fields.sessions) ?? "isolated";
      const extensions = formatValue(fields.extensions) ?? "0";
      write("╭─ Gemini Claw online ─────────────────────────────╮");
      write(`│ bot=${padRight(bot, 18)} mode=${padRight(mode, 8)} workers=${padRight(workers, 7)} │`);
      write(`│ model=${padRight(model, 17)} sessions=${padRight(sessions, 10)} ext=${padRight(extensions, 4)} │`);
      write("╰──────────────────────────────────────────────────╯");
    },
    info(event, fields) {
      writeEvent(options, write, event, "info", fields);
    },
    debug(event, fields) {
      writeEvent(options, write, event, "debug", fields);
    },
    error(event, fields) {
      writeEvent(options, write, event, "error", fields);
    }
  };

  return logger;
}

export const noopOperatorLogger: OperatorLogger = {
  includeContent: false,
  preview() {
    return undefined;
  },
  banner() {
    return undefined;
  },
  info() {
    return undefined;
  },
  debug() {
    return undefined;
  },
  error() {
    return undefined;
  }
};

function writeEvent(
  options: OperatorLoggerOptions,
  write: (line: string) => void,
  event: string,
  severity: LogSeverity,
  fields: Record<string, LogValue> | undefined
): void {
  if (!shouldLog(options.level, severity)) return;

  const safeFields = fields ?? {};
  if (options.style === "json") {
    writeJson(write, event, severity, safeFields);
    return;
  }

  write(options.style === "plain" ? formatPlain(event, severity, safeFields) : formatPretty(event, severity, safeFields));
}

function shouldLog(level: OperatorLogLevel, severity: LogSeverity): boolean {
  if (level === "silent") return false;
  if (severity === "error") return true;
  if (level === "debug") return true;
  return severity === "info";
}

function formatPretty(event: string, severity: LogSeverity, fields: Record<string, LogValue>): string {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const icon = icons[event] ?? (severity === "error" ? "⚠️" : "•");
  const label = event.replace(/_/g, " ");
  const payload = formatFields(fields);
  return `${time}  ${icon} ${padRight(label, 18)}${payload ? ` ${payload}` : ""}`;
}

function formatPlain(event: string, severity: LogSeverity, fields: Record<string, LogValue>): string {
  const payload = formatFields(fields);
  return `[${severity}] ${event}${payload ? ` ${payload}` : ""}`;
}

function writeJson(
  write: (line: string) => void,
  event: string,
  severity: LogSeverity,
  fields: Record<string, LogValue>
): void {
  write(JSON.stringify({ ts: new Date().toISOString(), level: severity, event, ...compactFields(fields) }));
}

function formatFields(fields: Record<string, LogValue>): string {
  return Object.entries(compactFields(fields))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function compactFields(fields: Record<string, LogValue>): Record<string, Exclude<LogValue, undefined | null>> {
  const compacted: Record<string, Exclude<LogValue, undefined | null>> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function formatValue(value: LogValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value.join(",") : "none";
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  return String(value);
}

function previewText(value: string | undefined, maxLength: number, includeContent: boolean): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (includeContent || compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}
