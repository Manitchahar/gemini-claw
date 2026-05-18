import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Context } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import { GeminiCliError } from "../utils/errors.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import { chunkTelegramMessage } from "./messageUtils.js";
import { createToolProgressReporter } from "./toolProgress.js";

const DEFAULT_TYPING_ACTION_INTERVAL_MS = 4_000;
const DEFAULT_TOOL_PROGRESS_INTERVAL_MS = 1_500;
const GMAIL_HEALTH_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

export interface MessageHandlerOptions {
  assistant: Pick<AssistantService, "respondToText">;
  responseChunkSize: number;
  typingActionIntervalMs?: number;
  toolProgressIntervalMs?: number;
  logger?: OperatorLogger;
}

export function createTextMessageHandler(options: MessageHandlerOptions) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;

    if (!text || !ctx.chat || !ctx.from) {
      await ctx.reply("Please send a text message.");
      return;
    }

    if (text.startsWith("/")) {
      await ctx.reply("Unknown command. Use /help for available commands.");
      return;
    }

    try {
      const stopTyping = startTypingIndicator(ctx, options.typingActionIntervalMs ?? DEFAULT_TYPING_ACTION_INTERVAL_MS);
      let response: string;

      try {
        const progress = createToolProgressReporter(
          ctx,
          options.toolProgressIntervalMs ?? DEFAULT_TOOL_PROGRESS_INTERVAL_MS
        );
        response = await options.assistant.respondToText({
          chatId: String(ctx.chat.id),
          userId: String(ctx.from.id),
          text,
          onEvent: (event) => progress(event)
        });
      } finally {
        stopTyping();
      }

      for (const chunk of chunkTelegramMessage(response, options.responseChunkSize)) {
        await ctx.reply(chunk);
      }
      options.logger?.debug("chat_reply", {
        chat: String(ctx.chat.id),
        chunks: chunkTelegramMessage(response, options.responseChunkSize).length,
        chars: response.length
      });
    } catch (error) {
      const logger = options.logger ?? noopOperatorLogger;
      logger.error("chat_error", { chat: ctx.chat ? String(ctx.chat.id) : undefined, error: formatErrorForLogs(error) });
      console.error(formatErrorForLogs(error));
      await ctx.reply(formatErrorForUser(error));
    }
  };
}

export function createUnsupportedMessageHandler() {
  return async (ctx: Context): Promise<void> => {
    const kind = detectUnsupportedMessageKind(ctx);
    await ctx.reply(
      [
        `${kind} input is not supported yet.`,
        "For now, send text prompts only. If this is a file or media item, paste the relevant text or a local file path that Gemini CLI can read."
      ].join("\n")
    );
  };
}

function detectUnsupportedMessageKind(ctx: Context): string {
  const message = ctx.message as
    | {
        photo?: unknown;
        voice?: unknown;
        audio?: unknown;
        video?: unknown;
        video_note?: unknown;
        document?: unknown;
        animation?: unknown;
        sticker?: unknown;
        location?: unknown;
        contact?: unknown;
        poll?: unknown;
        caption?: string;
      }
    | undefined;

  if (!message) {
    return "This message";
  }

  if (message.photo) return message.caption ? "Photo with caption" : "Photo";
  if (message.voice) return "Voice message";
  if (message.audio) return "Audio";
  if (message.video) return "Video";
  if (message.video_note) return "Video note";
  if (message.document) return "Document";
  if (message.animation) return "Animation";
  if (message.sticker) return "Sticker";
  if (message.location) return "Location";
  if (message.contact) return "Contact";
  if (message.poll) return "Poll";

  return "This message type";
}

function startTypingIndicator(ctx: Context, intervalMs: number): () => void {
  if (!ctx.chat) {
    return () => undefined;
  }

  const chatId = ctx.chat.id;
  void ctx.api.sendChatAction(chatId, "typing").catch((error: unknown) => {
    console.error(formatErrorForLogs(error));
  });

  const timer = setInterval(() => {
    void ctx.api.sendChatAction(chatId, "typing").catch((error: unknown) => {
      console.error(formatErrorForLogs(error));
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

function isGmailHealthCheck(text: string): boolean {
  return (
    /\bgmail\b/i.test(text) &&
    /\b(?:health|connected|connection|connectivity|ok|fail|working)\b/i.test(text)
  );
}

export async function runGmailHealthCheck(): Promise<string> {
  try {
    const stdout = await runGwsCommand(["gmail", "users", "getProfile", "--params", "{\"userId\":\"me\"}"], GMAIL_HEALTH_TIMEOUT_MS);
    const parsed = parseFirstJsonObject(stdout);
    return parsed && typeof parsed.emailAddress === "string"
      ? "GMAIL_OK: Gmail profile read succeeded."
      : "GMAIL_FAIL: Gmail profile response was not recognized.";
  } catch (error) {
    return `GMAIL_FAIL: ${formatShortError(error)}`;
  }
}

function isGmailRecentSearch(text: string): boolean {
  return (
    /\b(?:gmail|emails?|mails?|inbox)\b/i.test(text) &&
    /\b(?:find|show|list|recent|latest|last|received|inbox)\b/i.test(text) &&
    !/\b(?:send|reply|forward|draft|delete|archive|label)\b/i.test(text)
  );
}

function isGmailSentCount(text: string): boolean {
  return (
    /\b(?:gmail|emails?|mails?)\b/i.test(text) &&
    /\b(?:how\s+many|count)\b/i.test(text) &&
    /\b(?:sent|send|set)\b/i.test(text) &&
    /\b(?:today|yesterday|yesterdya)\b/i.test(text)
  );
}

export async function runGmailSentCount(text: string): Promise<string> {
  const day = /\btoday\b/i.test(text) ? "today" : "yesterday";
  const range = getGmailDateRange(day);
  const query = `in:sent after:${range.after} before:${range.before}`;

  try {
    const output = await runGwsCommand(
      ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", q: query, maxResults: 10 })],
      15_000
    );
    const parsed = parseFirstJsonObject(output);
    const count = typeof parsed?.resultSizeEstimate === "number" ? parsed.resultSizeEstimate : countMessages(parsed?.messages);
    return `GMAIL_SENT_COUNT: ${count} sent message${count === 1 ? "" : "s"} ${day}.`;
  } catch (error) {
    return `GMAIL_FAIL: ${formatShortError(error)}`;
  }
}

function countMessages(messages: unknown): number {
  return Array.isArray(messages) ? messages.length : 0;
}

function getGmailDateRange(day: "today" | "yesterday"): { after: string; before: string } {
  const start = startOfLocalDay(new Date());
  if (day === "yesterday") {
    start.setDate(start.getDate() - 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    after: formatGmailDate(start),
    before: formatGmailDate(end)
  };
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatGmailDate(date: Date): string {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function isCalendarAgendaRequest(text: string): boolean {
  return (
    /\b(?:calendar|agenda|meetings?|events?)\b/i.test(text) &&
    /\b(?:today|tomorrow|week|upcoming|next)\b/i.test(text) &&
    !/\b(?:create|schedule|add|move|reschedule|delete|cancel|invite)\b/i.test(text)
  );
}

export async function runCalendarAgenda(text: string): Promise<string> {
  const range = /\btomorrow\b/i.test(text) ? "tomorrow" : /\bweek\b/i.test(text) ? "week" : "today";
  const privacySafe = /\b(?:privacy-safe|private|redact|no\s+(?:title|summary|location|attendees?))\b/i.test(text);
  const args = ["calendar", "+agenda", `--${range}`, "--format", "json"];

  try {
    const output = await runGwsCommand(args, 15_000);
    const parsed = parseFirstJsonObject(output);
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    if (events.length === 0) {
      return `Calendar agenda ${range}: no events found.`;
    }

    const lines = events.slice(0, 5).map((event, index) => formatCalendarEventSummary(event, index + 1, privacySafe));
    return [`Calendar agenda ${range}: ${events.length} event${events.length === 1 ? "" : "s"}.`, ...lines].join("\n");
  } catch (error) {
    return `CALENDAR_FAIL: ${formatShortError(error)}`;
  }
}

function formatCalendarEventSummary(event: unknown, index: number, privacySafe: boolean): string {
  if (!isRecord(event)) {
    return `${index}. Unrecognized event`;
  }

  const start = typeof event.start === "string" ? event.start : "unknown start";
  const end = typeof event.end === "string" ? event.end : "unknown end";
  const summary = typeof event.summary === "string" && event.summary.trim() ? event.summary.trim() : "(no title)";
  const location = typeof event.location === "string" && event.location.trim() ? ` | ${event.location.trim()}` : "";

  return privacySafe
    ? `${index}. ${start} -> ${end} | title: ${summary === "(no title)" ? "missing" : "present"}`
    : `${index}. ${start} -> ${end} | ${summary}${location}`;
}

function isDriveRecentFilesRequest(text: string): boolean {
  return (
    /\b(?:drive|files?)\b/i.test(text) &&
    /\b(?:recent|latest|last|show|list|find)\b/i.test(text) &&
    !/\b(?:upload|create|delete|move|share|rename|copy)\b/i.test(text)
  );
}

export async function runDriveRecentFiles(text: string): Promise<string> {
  const count = extractRequestedCount(text, 3);
  const privacySafe = /\b(?:privacy-safe|private|redact|no\s+(?:names?|links?|titles?))\b/i.test(text);

  try {
    const output = await runGwsCommand(
      [
        "drive",
        "files",
        "list",
        "--params",
        JSON.stringify({
          pageSize: count,
          orderBy: "modifiedTime desc",
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)"
        })
      ],
      15_000
    );
    const parsed = parseFirstJsonObject(output);
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    if (files.length === 0) {
      return "Recent Drive files: none found.";
    }

    const lines = files.slice(0, count).map((file, index) => formatDriveFileSummary(file, index + 1, privacySafe));
    return [`Recent Drive files: ${files.length} shown.`, ...lines].join("\n");
  } catch (error) {
    return `DRIVE_FAIL: ${formatShortError(error)}`;
  }
}

function formatDriveFileSummary(file: unknown, index: number, privacySafe: boolean): string {
  if (!isRecord(file)) {
    return `${index}. Unrecognized file`;
  }

  const modified = typeof file.modifiedTime === "string" ? file.modifiedTime : "unknown modified time";
  const mimeType = typeof file.mimeType === "string" ? file.mimeType : "unknown type";
  const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "(unnamed)";
  const link = typeof file.webViewLink === "string" && file.webViewLink.trim() ? ` | ${file.webViewLink.trim()}` : "";

  return privacySafe
    ? `${index}. ${modified} | type: ${mimeType} | name: ${name === "(unnamed)" ? "missing" : "present"}`
    : `${index}. ${modified} | ${name} | ${mimeType}${link}`;
}

export async function runGmailRecentSearch(text: string): Promise<string> {
  const count = extractRequestedCount(text, 3);
  const privacySafe = /\b(?:privacy-safe|private|redact|no\s+(?:sender|subject|snippet|body|content))\b/i.test(text);

  try {
    const listOutput = await runGwsCommand(
      ["gmail", "users", "messages", "list", "--params", JSON.stringify({ userId: "me", maxResults: count })],
      15_000
    );
    const list = parseFirstJsonObject(listOutput);
    const messages = Array.isArray(list?.messages) ? list.messages : [];
    const ids = messages
      .map((message) => (isRecord(message) && typeof message.id === "string" ? message.id : undefined))
      .filter((id): id is string => Boolean(id))
      .slice(0, count);

    if (ids.length === 0) {
      return "No recent Gmail messages found.";
    }

    const details = await Promise.all(ids.map((id) => readGmailMessageMetadata(id)));
    const lines = details.map((message, index) => formatGmailMessageSummary(message, index + 1, privacySafe));
    return ["Recent Gmail messages:", ...lines].join("\n");
  } catch (error) {
    return `GMAIL_FAIL: ${formatShortError(error)}`;
  }
}

function extractRequestedCount(text: string, defaultCount: number): number {
  const match = text.match(/\b([1-9]|10)\b/);
  return match ? Number(match[1]) : defaultCount;
}

async function readGmailMessageMetadata(id: string): Promise<GmailMessageMetadata> {
  const output = await runGwsCommand(
    [
      "gmail",
      "users",
      "messages",
      "get",
      "--params",
      JSON.stringify({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })
    ],
    15_000
  );
  const parsed = parseFirstJsonObject(output);
  const headers = isRecord(parsed?.payload) && Array.isArray(parsed.payload.headers) ? parsed.payload.headers : [];

  return {
    id,
    date: getHeaderValue(headers, "Date") || (typeof parsed?.internalDate === "string" ? formatInternalDate(parsed.internalDate) : "unknown date"),
    from: getHeaderValue(headers, "From") || "unknown sender",
    subject: getHeaderValue(headers, "Subject") || ""
  };
}

interface GmailMessageMetadata {
  id: string;
  date: string;
  from: string;
  subject: string;
}

function getHeaderValue(headers: unknown[], name: string): string | undefined {
  const header = headers.find((item) => {
    return isRecord(item) && typeof item.name === "string" && item.name.toLowerCase() === name.toLowerCase();
  });

  return isRecord(header) && typeof header.value === "string" ? header.value : undefined;
}

function formatGmailMessageSummary(message: GmailMessageMetadata, index: number, privacySafe: boolean): string {
  if (privacySafe) {
    return `${index}. ${message.date} | from domain: ${extractEmailDomain(message.from)} | subject: ${message.subject ? "present" : "missing"}`;
  }

  return `${index}. ${message.date}\nFrom: ${message.from}\nSubject: ${message.subject || "(no subject)"}`;
}

function extractEmailDomain(value: string): string {
  const match = value.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1].toLowerCase() : "unknown";
}

function formatInternalDate(value: string): string {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "unknown date";
}

async function runGwsCommand(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [resolveGwsRunJs(), ...args], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 256 * 1024
  });
  return stdout;
}

function resolveGwsRunJs(): string {
  if (process.env.GWS_CLI_COMMAND) {
    return process.env.GWS_CLI_COMMAND;
  }

  const appData = process.env.APPDATA;
  return appData ? join(appData, "npm", "node_modules", "@googleworkspace", "cli", "run.js") : "gws";
}

function parseFirstJsonObject(output: string): Record<string, unknown> | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


function formatErrorForUser(error: unknown): string {
  if (error instanceof GeminiCliError) {
    const stderr = error.details?.stderr ?? "";
    if (/timed out/i.test(error.message)) {
      return "I hit the Gemini CLI timeout before it returned. Try a smaller request, or retry in a minute.";
    }
    if (/429|rateLimitExceeded|No capacity available/i.test(stderr)) {
      return "Gemini is capacity-limited right now under auto model routing. Please retry in a minute.";
    }
    return `I hit a Gemini CLI error: ${formatShortError(error)}`;
  }

  return `Sorry, I could not complete that request: ${formatShortError(error)}`;
}

function formatErrorForLogs(error: unknown): string {
  if (error instanceof GeminiCliError) {
    const stderr = error.details?.stderr ? ` stderr=${JSON.stringify(error.details.stderr.slice(0, 1000))}` : "";
    return `${error.name}: ${error.message}${stderr}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function formatShortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 220) || "unknown error";
}
