import "dotenv/config";

import { AssistantService } from "./assistant/assistantService.js";
import { ChatOperationQueue } from "./assistant/chatQueue.js";
import { AssistantTaskManager } from "./assistant/taskManager.js";
import { createTelegramBot } from "./bot/telegramBot.js";
import { loadConfig } from "./config.js";
import { CliGeminiClient } from "./gemini/CliGeminiClient.js";
import { JsonSessionStore } from "./storage/JsonSessionStore.js";
import { JsonTaskStore } from "./storage/JsonTaskStore.js";
import { existsSync, mkdirSync } from "node:fs";
import { createOperatorLogger } from "./utils/operatorLogger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.geminiCwd && !existsSync(config.geminiCwd)) {
    mkdirSync(config.geminiCwd, { recursive: true });
  }
  const logger = createOperatorLogger({
    level: config.operatorLogLevel,
    style: config.operatorLogStyle,
    includeContent: config.operatorLogContent,
    previewChars: config.operatorLogPreviewChars
  });
  const geminiClient = new CliGeminiClient({
    command: config.geminiCliCommand,
    outputFormat: config.geminiOutputFormat,
    timeoutMs: config.geminiTimeoutMs,
    model: config.geminiModel,
    yolo: config.geminiYolo,
    approvalMode: config.geminiApprovalMode,
    sandbox: config.geminiSandbox,
    debug: config.geminiDebug,
    trustWorkspace: config.geminiTrustWorkspace,
    cwd: config.geminiCwd,
    allowedTools: config.geminiAllowedTools,
    allowedMcpServerNames: config.geminiAllowedMcpServerNames,
    extensions: config.geminiExtensions,
    includeDirectories: config.geminiIncludeDirectories,
    settings: config.geminiSettings,
    logger
  });
  const sessionStore = new JsonSessionStore(config.sessionStorePath);
  const taskStore = new JsonTaskStore(config.taskStorePath);
  const chatQueue = new ChatOperationQueue();
  const taskManager = new AssistantTaskManager(geminiClient, sessionStore, {
    systemInstruction: config.assistantSystemInstruction,
    maxWorkers: config.geminiMaxWorkers,
    maxChatWorkers: config.geminiMaxChatWorkers,
    maxQueuedTasks: config.geminiMaxQueuedTasks,
    maxChatQueuedTasks: config.geminiMaxChatQueuedTasks,
    historyLimit: config.geminiTaskHistoryLimit,
    workerSessionMode: config.geminiWorkerSessionMode,
    extensions: config.geminiExtensions,
    sharedChatQueue: chatQueue,
    logger,
    taskStore
  });
  const assistant = new AssistantService(
    geminiClient,
    sessionStore,
    {
      systemInstruction: config.assistantSystemInstruction,
      resumeSessions: config.geminiResumeSessions
    },
    taskManager,
    chatQueue,
    logger
  );
  const bot = createTelegramBot(config, assistant, logger);

  await bot.start({
    onStart: (botInfo) => {
      logger.banner({
        bot: `@${botInfo.username}`,
        mode: config.geminiYolo ? "YOLO" : "safe",
        workers: `0/${config.geminiMaxWorkers}`,
        model: config.geminiModel ?? "default",
        sessions: config.geminiWorkerSessionMode,
        extensions: String(config.geminiExtensions.length)
      });
      console.log(`Telegram Gemini assistant started as @${botInfo.username}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
