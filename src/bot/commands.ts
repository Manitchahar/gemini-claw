import type { Bot } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import { TaskQueueFullError } from "../assistant/taskManager.js";
import type { AssistantTaskSummary, SubagentStatus, WorkerStats } from "../assistant/types.js";
import { chunkTelegramMessage } from "./messageUtils.js";

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
  maxWorkers: number;
  maxChatWorkers: number;
  maxQueuedTasks: number;
  maxChatQueuedTasks: number;
  taskHistoryLimit: number;
  workerSessionMode: "isolated" | "chat";
  responseChunkSize: number;
}

export function registerCommands(bot: Bot, assistant: AssistantService, options: OperatorCommandOptions): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Hi, I am your private Gemini-powered assistant.",
        "Send me a text message and I will respond here.",
        "Use /task <prompt> to run a background Gemini worker.",
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

  bot.command("task", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot start a task without a private chat and user.");
      return;
    }

    const prompt = extractCommandArgument(ctx.message?.text, "task");
    if (!prompt) {
      await ctx.reply("Usage: /task <prompt>");
      return;
    }

    try {
      const task = assistant.startTask(
        {
          chatId: String(ctx.chat.id),
          userId: String(ctx.from.id),
          text: prompt
        },
        {
          onComplete: async (completed) => {
            await replyWithTaskCompletion(ctx.reply.bind(ctx), completed, options.responseChunkSize);
          }
        }
      );

      await ctx.reply(`Started task ${task.id}. Use /task_status ${task.id} to check it.`);
    } catch (error) {
      if (error instanceof TaskQueueFullError) {
        await ctx.reply(error.message);
        return;
      }

      throw error;
    }
  });

  bot.command("tasks", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    await ctx.reply(formatTasksMessage(assistant.listTasks(String(ctx.chat.id))));
  });

  bot.command("task_status", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const taskId = extractCommandArgument(ctx.message?.text, "task_status");
    if (!taskId) {
      await ctx.reply("Usage: /task_status <task-id>");
      return;
    }

    const task = assistant.getTask(String(ctx.chat.id), taskId);
    await ctx.reply(task ? formatTaskStatusMessage(task) : `Task ${taskId} was not found.`);
  });

  bot.command("cancel", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const taskId = extractCommandArgument(ctx.message?.text, "cancel");
    if (!taskId) {
      await ctx.reply("Usage: /cancel <task-id>");
      return;
    }

    const task = assistant.cancelTask(String(ctx.chat.id), taskId);
    if (!task) {
      await ctx.reply(`Task ${taskId} was not found.`);
      return;
    }

    await ctx.reply(task.status === "running" ? `Cancellation requested for task ${task.id}.` : `Task ${task.id} is ${task.status}.`);
  });

  bot.command("workers", async (ctx) => {
    await ctx.reply(formatWorkersMessage(assistant.getWorkerStats(), options));
  });

  bot.command("subagents", async (ctx) => {
    await ctx.reply(formatSubagentsMessage(assistant.getSubagentStatus(ctx.chat ? String(ctx.chat.id) : undefined)));
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
    "/task <prompt> - start a background Gemini CLI worker.",
    "/tasks - list running and recent tasks.",
    "/task_status <id> - show one task's status.",
    "/cancel <id> - cancel a queued or running task.",
    "/workers - show worker capacity.",
    "/subagents - show configured and observed subagent state.",
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
    `Workers: ${options.maxWorkers} total, ${options.maxChatWorkers} per chat`,
    `Worker sessions: ${options.workerSessionMode}`,
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
    `Settings file: ${options.settingsConfigured ? "configured" : "not configured"}`,
    "Subagents: available only when Gemini CLI extensions or settings provide them."
  ].join("\n");
}

export function formatPlanMessage(options: OperatorCommandOptions): string {
  return [
    "Operating plan:",
    "Accept private allowlisted Telegram messages, send them to Gemini CLI, and return the response here.",
    "Use /task for concurrent background workers; normal chat stays sequential.",
    `Mode: ${options.yolo ? "YOLO automation enabled" : "approval-gated/default automation"}.`,
    `Tools: ${options.allowedTools.length > 0 ? "explicit allowlist configured" : "Gemini CLI defaults"}.`,
    `Workers: ${options.maxWorkers} total, ${options.maxChatWorkers} per chat, ${options.workerSessionMode} sessions.`,
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

export function formatTasksMessage(tasks: readonly AssistantTaskSummary[]): string {
  if (tasks.length === 0) {
    return "No tasks yet. Use /task <prompt> to start one.";
  }

  return ["Tasks:", ...tasks.slice(0, 10).map((task) => `${task.id} - ${task.status} - ${preview(task.text, 60)}`)].join("\n");
}

export function formatTaskStatusMessage(task: AssistantTaskSummary): string {
  return [
    `Task ${task.id}: ${task.status}`,
    `Prompt: ${preview(task.text, 120)}`,
    `Tools: ${formatList(task.tools, "none observed")}`,
    `Failed tools: ${formatList(task.failedTools, "none")}`,
    `Subagents: ${formatList(task.possibleSubagents, "not observed")}`,
    task.error ? `Error: ${task.error}` : undefined,
    task.response ? `Result: ${preview(task.response, 500)}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatWorkersMessage(stats: WorkerStats, options: OperatorCommandOptions): string {
  return [
    "Workers:",
    `Running: ${stats.running}/${stats.maxWorkers}`,
    `Queued: ${stats.queued}/${stats.maxQueuedTasks}`,
    `Per-chat limit: ${stats.maxChatWorkers}`,
    `Per-chat queue limit: ${stats.maxChatQueuedTasks}`,
    `Session mode: ${options.workerSessionMode}`,
    `History limit: ${options.taskHistoryLimit}`,
    `Running task IDs: ${formatList(stats.runningTaskIds, "none")}`
  ].join("\n");
}

export function formatSubagentsMessage(status: SubagentStatus): string {
  return [
    "Subagents:",
    "SDK default: not available.",
    `CLI extensions configured: ${status.extensionsConfigured ? "yes" : "no"}`,
    `Configured extensions: ${formatList(status.configuredExtensions, "none")}`,
    `Observed subagents: ${formatList(status.observedSubagents, "not observed")}`,
    "Gemini CLI can use subagents only when extensions/settings provide them and the run emits evidence."
  ].join("\n");
}

async function replyWithTaskCompletion(
  reply: (text: string) => Promise<unknown>,
  task: AssistantTaskSummary,
  chunkSize: number
): Promise<void> {
  if (task.status === "succeeded") {
    const header = `Task ${task.id} completed.`;
    const response = task.response ?? "No response.";
    await reply(header);
    for (const chunk of chunkTelegramMessage(response, chunkSize)) {
      await reply(chunk);
    }
    return;
  }

  await reply(`Task ${task.id} ${task.status}${task.error ? `: ${task.error}` : "."}`);
}

function extractCommandArgument(text: string | undefined, command: string): string {
  if (!text) {
    return "";
  }

  const pattern = new RegExp(`^/${command}(?:@\\S+)?\\s*`, "i");
  return text.replace(pattern, "").trim();
}

function preview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}…`;
}
