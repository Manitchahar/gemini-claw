import type { Bot } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import { TaskQueueFullError } from "../assistant/taskManager.js";
import type { AssistantTaskSummary, SubagentStatus, WorkerStats } from "../assistant/types.js";
import { GeminiCliError } from "../utils/errors.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import { chunkTelegramMessage } from "./messageUtils.js";
import { runCalendarAgenda, runDriveRecentFiles, runGmailRecentSearch, runGmailSentCount } from "./messageHandler.js";
import { createToolProgressReporter } from "./toolProgress.js";

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
  logger?: OperatorLogger;
}

export function registerCommands(bot: Bot, assistant: AssistantService, options: OperatorCommandOptions): void {
  const logger = options.logger ?? noopOperatorLogger;
  const toolProgressIntervalMs = 1_500;

  bot.command("start", async (ctx) => {
    logCommand(logger, "start", ctx.chat?.id, ctx.from?.id);
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
    logCommand(logger, "help", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(formatHelpMessage());
  });

  bot.command("reset", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    logCommand(logger, "reset", ctx.chat.id, ctx.from?.id);
    await assistant.resetChat(String(ctx.chat.id));
    await ctx.reply("Reset complete.");
  });

  bot.command("status", async (ctx) => {
    logCommand(logger, "status", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(formatStatusMessage(options));
  });

  bot.command("tools", async (ctx) => {
    logCommand(logger, "tools", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(formatToolsMessage(options));
  });

  bot.command("plan", async (ctx) => {
    logCommand(logger, "plan", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(formatPlanMessage(options));
  });

  bot.command("demo_check", async (ctx) => {
    logCommand(logger, "demo_check", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(await runDemoCheck());
  });

  bot.command("task", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot start a task without a private chat and user.");
      return;
    }

    logCommand(logger, "task", ctx.chat.id, ctx.from.id);
    const prompt = extractCommandArgument(ctx.message?.text, "task");
    if (!prompt) {
      await ctx.reply("Usage: /task <prompt>");
      return;
    }

    try {
      const progress = createToolProgressReporter(ctx, toolProgressIntervalMs);
      const task = assistant.startTask(
        {
          chatId: String(ctx.chat.id),
          userId: String(ctx.from.id),
          text: prompt
        },
        {
          onEvent: (_summary, event) => progress(event),
          onComplete: async (completed) => {
            await replyWithTaskCompletion(ctx.reply.bind(ctx), completed, options.responseChunkSize);
          }
        }
      );

      await ctx.reply(`Started task ${task.id}. Use /task_status ${task.id} to check it.`);
    } catch (error) {
      if (error instanceof TaskQueueFullError) {
        logger.info("task_rejected", { chat: ctx.chat.id, user: ctx.from.id, reason: error.message });
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

    logCommand(logger, "tasks", ctx.chat.id, ctx.from?.id);
    await ctx.reply(formatTasksMessage(assistant.listTasks(String(ctx.chat.id))));
  });

  bot.command("task_status", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    logCommand(logger, "task_status", ctx.chat.id, ctx.from?.id);
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

    logCommand(logger, "cancel", ctx.chat.id, ctx.from?.id);
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

  bot.command("stop_all", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    logCommand(logger, "stop_all", ctx.chat.id, ctx.from?.id);
    const stopped = assistant.stopAllTasks(String(ctx.chat.id));
    await ctx.reply(`Stop requested for ${stopped.length} queued/running task${stopped.length === 1 ? "" : "s"}.`);
  });

  bot.command("pause", async (ctx) => {
    logCommand(logger, "pause", ctx.chat?.id, ctx.from?.id);
    const stats = assistant.pauseWorkers();
    await ctx.reply(`Workers paused. Running: ${stats.running}/${stats.maxWorkers}. Queued: ${stats.queued}.`);
  });

  bot.command("resume", async (ctx) => {
    logCommand(logger, "resume", ctx.chat?.id, ctx.from?.id);
    const stats = assistant.resumeWorkers();
    await ctx.reply(`Workers resumed. Running: ${stats.running}/${stats.maxWorkers}. Queued: ${stats.queued}.`);
  });

  bot.command("workers", async (ctx) => {
    logCommand(logger, "workers", ctx.chat?.id, ctx.from?.id);
    await ctx.reply(formatWorkersMessage(assistant.getWorkerStats(), options));
  });

  bot.command("sessions", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot list sessions without a private chat and user.");
      return;
    }

    logCommand(logger, "sessions", ctx.chat.id, ctx.from.id);
    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.listGeminiSessions(String(ctx.chat.id), String(ctx.from.id)), options.responseChunkSize);
  });

  bot.command("delete_session", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot delete a session without a private chat and user.");
      return;
    }

    logCommand(logger, "delete_session", ctx.chat.id, ctx.from.id);
    const session = extractCommandArgument(ctx.message?.text, "delete_session");
    if (!session) {
      await ctx.reply("Usage: /delete_session <id-or-index>");
      return;
    }

    await replyWithGeminiCommand(
      ctx.reply.bind(ctx),
      assistant.deleteGeminiSession(String(ctx.chat.id), String(ctx.from.id), session),
      options.responseChunkSize
    );
  });

  bot.command("mcp", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot list MCP servers without a private chat and user.");
      return;
    }

    logCommand(logger, "mcp", ctx.chat.id, ctx.from.id);
    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.listGeminiMcpServers(String(ctx.chat.id), String(ctx.from.id)), options.responseChunkSize);
  });

  bot.command("extensions", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot list extensions without a private chat and user.");
      return;
    }

    logCommand(logger, "extensions", ctx.chat.id, ctx.from.id);
    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.listGeminiExtensions(String(ctx.chat.id), String(ctx.from.id)), options.responseChunkSize);
  });

  bot.command("skills", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot list skills without a private chat and user.");
      return;
    }

    logCommand(logger, "skills", ctx.chat.id, ctx.from.id);
    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.listGeminiSkills(String(ctx.chat.id), String(ctx.from.id)), options.responseChunkSize);
  });

  bot.command("skill_link", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot link a skill without a private chat and user.");
      return;
    }

    logCommand(logger, "skill_link", ctx.chat.id, ctx.from.id);
    const path = extractCommandArgument(ctx.message?.text, "skill_link");
    if (!path) {
      await ctx.reply("Usage: /skill_link <local-path>");
      return;
    }

    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.linkGeminiSkill(String(ctx.chat.id), String(ctx.from.id), path), options.responseChunkSize);
  });

  bot.command("skill_install", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot install a skill without a private chat and user.");
      return;
    }

    logCommand(logger, "skill_install", ctx.chat.id, ctx.from.id);
    const source = extractCommandArgument(ctx.message?.text, "skill_install");
    if (!source) {
      await ctx.reply("Usage: /skill_install <git-url-or-local-path>");
      return;
    }

    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.installGeminiSkill(String(ctx.chat.id), String(ctx.from.id), source), options.responseChunkSize);
  });

  bot.command("skill_enable", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot enable a skill without a private chat and user.");
      return;
    }

    logCommand(logger, "skill_enable", ctx.chat.id, ctx.from.id);
    const name = extractCommandArgument(ctx.message?.text, "skill_enable");
    if (!name) {
      await ctx.reply("Usage: /skill_enable <name>");
      return;
    }

    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.enableGeminiSkill(String(ctx.chat.id), String(ctx.from.id), name), options.responseChunkSize);
  });

  bot.command("skill_disable", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot disable a skill without a private chat and user.");
      return;
    }

    logCommand(logger, "skill_disable", ctx.chat.id, ctx.from.id);
    const name = extractCommandArgument(ctx.message?.text, "skill_disable");
    if (!name) {
      await ctx.reply("Usage: /skill_disable <name>");
      return;
    }

    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.disableGeminiSkill(String(ctx.chat.id), String(ctx.from.id), name), options.responseChunkSize);
  });

  bot.command("skill_uninstall", async (ctx) => {
    if (!ctx.chat || !ctx.from) {
      await ctx.reply("Cannot uninstall a skill without a private chat and user.");
      return;
    }

    logCommand(logger, "skill_uninstall", ctx.chat.id, ctx.from.id);
    const name = extractCommandArgument(ctx.message?.text, "skill_uninstall");
    if (!name) {
      await ctx.reply("Usage: /skill_uninstall <name>");
      return;
    }

    await replyWithGeminiCommand(ctx.reply.bind(ctx), assistant.uninstallGeminiSkill(String(ctx.chat.id), String(ctx.from.id), name), options.responseChunkSize);
  });

  bot.command("subagents", async (ctx) => {
    logCommand(logger, "subagents", ctx.chat?.id, ctx.from?.id);
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
    "/demo_check - run read-only Gmail, Calendar, and Drive demo checks.",
    "/task <prompt> - start a background Gemini CLI worker.",
    "/tasks - list running and recent tasks.",
    "/task_status <id> - show one task's status.",
    "/cancel <id> - cancel a queued or running task.",
    "/stop_all - cancel this chat's queued and running tasks.",
    "/pause - pause starting new background workers.",
    "/resume - resume background workers.",
    "/workers - show worker capacity.",
    "/sessions - list Gemini CLI sessions for the current project.",
    "/delete_session <id-or-index> - delete a Gemini CLI session.",
    "/mcp - list configured Gemini CLI MCP servers.",
    "/extensions - list installed Gemini CLI extensions.",
    "/skills - list discovered Gemini CLI skills.",
    "/skill_link <local-path> - link a local Gemini CLI skill.",
    "/skill_install <git-url-or-local-path> - install a Gemini CLI skill.",
    "/skill_enable <name> - enable a Gemini CLI skill.",
    "/skill_disable <name> - disable a Gemini CLI skill.",
    "/skill_uninstall <name> - uninstall a Gemini CLI skill.",
    "/subagents - show configured and observed subagent state.",
    "For safety, this bot only responds to allowlisted Telegram users."
  ].join("\n");
}

async function runDemoCheck(): Promise<string> {
  const checks: Array<{ name: string; run: () => Promise<string> }> = [
    { name: "Gmail recent", run: () => runGmailRecentSearch("Find 3 recent Gmail messages privacy-safe") },
    { name: "Gmail sent count", run: () => runGmailSentCount("how many mails i set yesterdya") },
    { name: "Calendar today", run: () => runCalendarAgenda("show my calendar today privacy-safe") },
    { name: "Drive recent", run: () => runDriveRecentFiles("show recent drive files privacy-safe") }
  ];
  const results = [];

  for (const check of checks) {
    const startedAt = Date.now();
    try {
      const output = await check.run();
      const ok = !/\b(?:FAIL|failed|error)\b/i.test(output);
      results.push(`${check.name}: ${ok ? "OK" : "FAIL"} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      results.push(`${check.name}: FAIL (${Date.now() - startedAt}ms) ${preview(error instanceof Error ? error.message : String(error), 120)}`);
    }
  }

  return ["Demo check:", ...results, "Model: auto/default. Fast GSuite checks bypass Gemini for demo reliability."].join("\n");
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
    "Mode: YOLO automation is always enabled; Gemini CLI runs with --yolo for every request.",
    `Tools: ${options.allowedTools.length > 0 ? "explicit allowlist configured" : "Gemini CLI defaults"}.`,
    `Workers: ${options.maxWorkers} total, ${options.maxChatWorkers} per chat, ${options.workerSessionMode} sessions.`,
    "Use /status for runtime settings and /tools for tool, MCP, extension, and subagent visibility.",
    "Use /reset if this chat needs a fresh Gemini CLI session mapping."
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
    `Paused: ${formatEnabled(stats.paused)}`,
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

async function replyWithChunks(
  reply: (text: string) => Promise<unknown>,
  text: string,
  chunkSize: number
): Promise<void> {
  for (const chunk of chunkTelegramMessage(text, chunkSize)) {
    await reply(chunk);
  }
}

async function replyWithGeminiCommand(
  reply: (text: string) => Promise<unknown>,
  output: Promise<string>,
  chunkSize: number
): Promise<void> {
  try {
    await replyWithChunks(reply, await output, chunkSize);
  } catch (error) {
    await reply(formatGeminiCommandError(error));
  }
}

function formatGeminiCommandError(error: unknown): string {
  if (error instanceof GeminiCliError) {
    const stderr = error.details?.stderr;
    const hint = typeof stderr === "string" && stderr.trim() ? `\n\nDetails:\n${preview(stderr, 800)}` : "";
    return `Gemini CLI command failed: ${error.message}${hint}`;
  }

  if (error instanceof Error) {
    return `Gemini CLI command failed: ${error.message}`;
  }

  return `Gemini CLI command failed: ${String(error)}`;
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

function logCommand(logger: OperatorLogger, command: string, chatId: number | string | undefined, userId: number | string | undefined): void {
  logger.info("command", { command, chat: chatId === undefined ? undefined : String(chatId), user: userId === undefined ? undefined : String(userId) });
}
