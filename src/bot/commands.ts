import type { Bot } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";

export interface OperatorCommandOptions {
  model?: string;
  outputFormat: "json" | "stream-json";
  yolo: boolean;
  approvalMode?: string;
  sandbox: boolean;
  debug: boolean;
  allowedTools: readonly string[];
  allowedMcpServerNames: readonly string[];
  extensions: readonly string[];
  includeDirectories: readonly string[];
  settingsConfigured: boolean;
}

export function registerCommands(bot: Bot, assistant: AssistantService, options: OperatorCommandOptions): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Hi, I am your private Gemini-powered assistant.",
        "Send me a text message and I will respond here.",
        "Use /reset if you want to clear this chat's local session mapping."
      ].join("\n")
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(formatHelpMessage());
  });

  bot.command("reset", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    await assistant.resetChat(String(ctx.chat.id));
    await ctx.reply("Reset complete.");
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(formatStatusMessage(options));
  });

  bot.command("tools", async (ctx) => {
    await ctx.reply(formatToolsMessage(options));
  });

  bot.command("plan", async (ctx) => {
    await ctx.reply(formatPlanMessage(options));
  });

  bot.command("yolo", async (ctx) => {
    await ctx.reply(formatYoloMessage(options));
  });
}

export function formatHelpMessage(): string {
  return [
    "Send any text prompt to ask Gemini.",
    "Commands:",
    "/start - introduce the bot.",
    "/help - show this help.",
    "/reset - clear this Telegram chat's local session mapping.",
    "/status - show safe runtime status.",
    "/tools - show configured tool and extension visibility.",
    "/plan - show the current operating mode summary.",
    "/yolo - show YOLO mode state and warning.",
    "For safety, this bot only responds to allowlisted Telegram users."
  ].join("\n");
}

export function formatStatusMessage(options: OperatorCommandOptions): string {
  return [
    "Runtime status:",
    `Model: ${options.model ?? "Gemini CLI default"}`,
    `Output format: ${options.outputFormat}`,
    `YOLO: ${formatEnabled(options.yolo)}`,
    `Approval mode: ${options.approvalMode ?? "Gemini CLI default"}`,
    `Sandbox: ${formatEnabled(options.sandbox)}`,
    `Debug: ${formatEnabled(options.debug)}`,
    "Sessions: Telegram chat IDs are mapped to Gemini CLI sessions locally; /reset clears this chat's mapping."
  ].join("\n");
}

export function formatToolsMessage(options: OperatorCommandOptions): string {
  return [
    "Tool configuration:",
    `Allowed tools: ${formatList(options.allowedTools, "Gemini CLI default (no explicit allowlist)")}`,
    `Allowed MCP servers: ${formatList(options.allowedMcpServerNames, "none configured")}`,
    `Extensions: ${formatList(options.extensions, "none configured")}`,
    `Include directories: ${formatList(options.includeDirectories, "none configured")}`,
    `Settings file: ${options.settingsConfigured ? "configured" : "not configured"}`
  ].join("\n");
}

export function formatPlanMessage(options: OperatorCommandOptions): string {
  return [
    "Operating plan:",
    "Accept private allowlisted Telegram messages, send them to Gemini CLI, and return the response here.",
    `Mode: ${options.yolo ? "YOLO automation enabled" : "approval-gated/default automation"}.`,
    `Tools: ${options.allowedTools.length > 0 ? "explicit allowlist configured" : "Gemini CLI defaults"}.`,
    "Use /reset if this chat needs a fresh Gemini CLI session mapping."
  ].join("\n");
}

export function formatYoloMessage(options: OperatorCommandOptions): string {
  return [
    `YOLO is currently ${formatEnabled(options.yolo)}.`,
    "Warning: YOLO can allow Gemini CLI to act with fewer confirmations. Keep it off unless you explicitly trust the runtime and tool scope.",
    "Control is environment-driven with GEMINI_YOLO; restart the bot after changing it. No chat command toggles are enabled."
  ].join("\n");
}

function formatEnabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function formatList(values: readonly string[], emptyLabel: string): string {
  return values.length > 0 ? values.join(", ") : emptyLabel;
}
