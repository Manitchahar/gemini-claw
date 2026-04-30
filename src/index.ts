import "dotenv/config";

import { AssistantService } from "./assistant/assistantService.js";
import { ChatOperationQueue } from "./assistant/chatQueue.js";
import { AssistantTaskManager } from "./assistant/taskManager.js";
import { createTelegramBot } from "./bot/telegramBot.js";
import { loadConfig } from "./config.js";
import { CliGeminiClient } from "./gemini/CliGeminiClient.js";
import { JsonSessionStore } from "./storage/JsonSessionStore.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const geminiClient = new CliGeminiClient({
    command: config.geminiCliCommand,
    outputFormat: config.geminiOutputFormat,
    timeoutMs: config.geminiTimeoutMs,
    model: config.geminiModel,
    yolo: config.geminiYolo,
    approvalMode: config.geminiApprovalMode,
    sandbox: config.geminiSandbox,
    debug: config.geminiDebug,
    cwd: config.geminiCwd,
    allowedTools: config.geminiAllowedTools,
    allowedMcpServerNames: config.geminiAllowedMcpServerNames,
    extensions: config.geminiExtensions,
    includeDirectories: config.geminiIncludeDirectories,
    settings: config.geminiSettings
  });
  const sessionStore = new JsonSessionStore(config.sessionStorePath);
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
    sharedChatQueue: chatQueue
  });
  const assistant = new AssistantService(
    geminiClient,
    sessionStore,
    {
      systemInstruction: config.assistantSystemInstruction
    },
    taskManager,
    chatQueue
  );
  const bot = createTelegramBot(config, assistant);

  await bot.start({
    onStart: (botInfo) => {
      console.log(`Telegram Gemini assistant started as @${botInfo.username}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
