import type { Context } from "grammy";

import type { AssistantEvent } from "../assistant/types.js";

export function createToolProgressReporter(ctx: Context, intervalMs: number): (event: AssistantEvent) => Promise<void> {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastProgressKey = "";
  let statusMessageId: number | undefined;

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
      if (ctx.chat && statusMessageId !== undefined) {
        await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text);
        return;
      }

      const message = await ctx.reply(text);
      if (isTelegramMessageWithId(message)) {
        statusMessageId = message.message_id;
      }
    } catch (error) {
      console.error(formatErrorForLogs(error));
    }
  };
}

function formatToolProgress(event: AssistantEvent): string | undefined {
  if (event.type === "tool_start") {
    return `Tool ${sanitizeToolName(event.name)} started.`;
  }

  if (event.type === "tool_end") {
    const status = event.success ? "finished" : "failed";
    const prefix = event.success ? "Done" : "Warning";
    return `${prefix}: ${sanitizeToolName(event.name)} ${status}.`;
  }

  return undefined;
}

function sanitizeToolName(name: string): string {
  const normalized = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "Tool";
}

function isTelegramMessageWithId(value: unknown): value is { message_id: number } {
  return typeof value === "object" && value !== null && "message_id" in value && typeof value.message_id === "number";
}

function formatErrorForLogs(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
