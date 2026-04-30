import type { Context } from "grammy";

export function isAllowedUser(userId: number | string | undefined, allowedUserIds: ReadonlySet<string>): boolean {
  return userId !== undefined && allowedUserIds.has(String(userId));
}

export function isPrivateChat(chatType: string | undefined): boolean {
  return chatType === "private";
}

export async function requireAllowedUser(
  ctx: Context,
  allowedUserIds: ReadonlySet<string>,
  next: () => Promise<void>
): Promise<void> {
  if (!isPrivateChat(ctx.chat?.type)) {
    if (ctx.chat) {
      await ctx.reply("For privacy, this personal assistant only works in a direct chat.");
    }
    return;
  }

  if (isAllowedUser(ctx.from?.id, allowedUserIds)) {
    await next();
    return;
  }

  if (ctx.chat) {
    await ctx.reply("Sorry, this personal assistant is private.");
  }
}
