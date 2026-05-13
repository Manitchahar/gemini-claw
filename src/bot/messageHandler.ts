import type { Context } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import { GeminiCliError } from "../utils/errors.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import { chunkTelegramMessage } from "./messageUtils.js";
import { createToolProgressReporter } from "./toolProgress.js";

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
