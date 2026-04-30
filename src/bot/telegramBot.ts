import { Bot, GrammyError, HttpError } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";
import type { AppConfig } from "../config.js";
import { requireAllowedUser } from "./auth.js";
import { registerCommands } from "./commands.js";
import { createTextMessageHandler } from "./messageHandler.js";

export function createTelegramBot(config: AppConfig, assistant: AssistantService): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    await requireAllowedUser(ctx, config.telegramAllowedUserIds, next);
  });

  registerCommands(bot, assistant, {
    model: config.geminiModel,
    outputFormat: config.geminiOutputFormat,
    yolo: config.geminiYolo,
    approvalMode: config.geminiApprovalMode,
    sandbox: config.geminiSandbox,
    debug: config.geminiDebug,
    allowedTools: config.geminiAllowedTools,
    allowedMcpServerNames: config.geminiAllowedMcpServerNames,
    extensions: config.geminiExtensions,
    includeDirectories: config.geminiIncludeDirectories,
    settingsConfigured: config.geminiSettings !== undefined
  });

  bot.on(
    "message:text",
    createTextMessageHandler({
      assistant,
      responseChunkSize: config.telegramResponseChunkSize
    })
  );

  bot.on("message", async (ctx) => {
    await ctx.reply("Please send a text message.");
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    const err = error.error;

    if (err instanceof GrammyError) {
      console.error(`Telegram API error while handling update ${ctx.update.update_id}: ${err.description}`);
      return;
    }

    if (err instanceof HttpError) {
      console.error(`Telegram HTTP error while handling update ${ctx.update.update_id}: ${err.message}`);
      return;
    }

    console.error(`Unexpected bot error while handling update ${ctx.update.update_id}:`, err);
  });

  return bot;
}
