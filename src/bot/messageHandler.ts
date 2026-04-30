import type { Context } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import type { AssistantEvent } from "../assistant/types.js";
import { GeminiCliError } from "../utils/errors.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import { chunkTelegramMessage } from "./messageUtils.js";

const DEFAULT_TYPING_ACTION_INTERVAL_MS = 4_000;
const DEFAULT_TOOL_PROGRESS_INTERVAL_MS = 1_500;

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
      await ctx.reply("Sorry, I could not complete that request.");
    }
  };
}

function createToolProgressReporter(ctx: Context, intervalMs: number): (event: AssistantEvent) => Promise<void> {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastProgressKey = "";

  return async (event: AssistantEvent): Promise<void> => {
    if (event.type !== "tool_start" && event.type !== "tool_end") {
      return;
    }

    const text = formatToolProgress(event);
    if (!text) {
      return;
    }

    const key = event.type === "tool_end" ? `${event.type}:${event.name}:${event.success}` : `${event.type}:${event.name}`;
    const now = Date.now();
    const isCompletingLastStartedTool = event.type === "tool_end" && lastProgressKey === `tool_start:${event.name}`;
    if (key === lastProgressKey || (!isCompletingLastStartedTool && now - lastSentAt < intervalMs)) {
      return;
    }

    lastProgressKey = key;
    lastSentAt = now;

    try {
        await ctx.reply(text);
      } catch (error) {
        console.error(formatErrorForLogs(error));
      }
  };
}

function formatToolProgress(event: AssistantEvent): string | undefined {
  if (event.type === "tool_start") {
    return `🔧 ${sanitizeToolName(event.name)} started.`;
  }

  if (event.type === "tool_end") {
    const status = event.success ? "finished" : "failed";
    const icon = event.success ? "✅" : "⚠️";
    return `${icon} ${sanitizeToolName(event.name)} ${status}.`;
  }

  return undefined;
}

function sanitizeToolName(name: string): string {
  const normalized = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "Tool";
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
