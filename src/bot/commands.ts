import type { Bot } from "grammy";

import type { AssistantService } from "../assistant/assistantService.js";

export function registerCommands(bot: Bot, assistant: AssistantService): void {
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
    await ctx.reply(
      [
        "Send any text prompt to ask Gemini.",
        "/reset clears this Telegram chat's local session mapping.",
        "For safety, this bot only responds to allowlisted Telegram users."
      ].join("\n")
    );
  });

  bot.command("reset", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    await assistant.resetChat(String(ctx.chat.id));
    await ctx.reply("Reset complete.");
  });
}
