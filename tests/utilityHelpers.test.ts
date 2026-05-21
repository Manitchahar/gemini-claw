import { describe, expect, it } from "vitest";

import { buildAssistantPrompt, DEFAULT_SYSTEM_INSTRUCTION } from "../src/assistant/prompts.js";
import { GeminiCliError, ConfigurationError } from "../src/utils/errors.js";
import { SdkGeminiClient } from "../src/gemini/SdkGeminiClient.js";

describe("prompt helpers", () => {
  it("builds a trimmed Telegram-specific assistant prompt", () => {
    expect(buildAssistantPrompt("  hello  ", "  Be useful.  ")).toBe(
      "Be useful.\n\nThe user is messaging from Telegram. Respond in a Telegram-friendly format.\n\nUser message:\nhello"
    );
  });

  it("keeps the default system instruction aligned with terse operator output", () => {
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("Output compression");
    expect(DEFAULT_SYSTEM_INSTRUCTION).toContain("Respond terse.");
  });
});

describe("error helpers", () => {
  it("preserves error metadata", () => {
    expect(new ConfigurationError("bad config")).toMatchObject({
      name: "ConfigurationError",
      message: "bad config"
    });

    expect(new GeminiCliError("oops", { exitCode: 1, stderr: "no auth" })).toMatchObject({
      name: "GeminiCliError",
      message: "oops",
      details: { exitCode: 1, stderr: "no auth" }
    });
  });
});

describe("SdkGeminiClient", () => {
  it("throws when the unavailable SDK client is used", async () => {
    const client = new SdkGeminiClient();
    const iterator = client.sendMessage("hello", { chatId: "chat-1", userId: "user-1" })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(
      "First-party Gemini CLI SDK integration is intentionally unavailable and not the default until a stable package is published for this app."
    );
  });
});
