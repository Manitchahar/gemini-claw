import { describe, expect, it } from "vitest";

import { chunkTelegramMessage } from "../src/bot/messageUtils.js";

describe("chunkTelegramMessage", () => {
  it("returns a single chunk for short messages", () => {
    expect(chunkTelegramMessage("hello", 10)).toEqual(["hello"]);
  });

  it("splits long messages at safe boundaries", () => {
    const chunks = chunkTelegramMessage("hello world from telegram", 13);

    expect(chunks).toEqual(["hello world", "from telegram"]);
    expect(chunks.every((chunk) => chunk.length <= 13)).toBe(true);
  });

  it("returns a fallback for empty messages", () => {
    expect(chunkTelegramMessage("   ", 10)).toEqual(["I did not receive a response."]);
  });
});
