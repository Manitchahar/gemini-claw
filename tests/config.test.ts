import { describe, expect, it } from "vitest";

import { loadConfig, parseAllowedUserIds } from "../src/config.js";
import { ConfigurationError } from "../src/utils/errors.js";

describe("config", () => {
  it("parses allowed Telegram user IDs", () => {
    expect([...parseAllowedUserIds("123, 456")]).toEqual(["123", "456"]);
  });

  it("rejects invalid Telegram user IDs", () => {
    expect(() => parseAllowedUserIds("123,abc")).toThrow(ConfigurationError);
  });

  it("loads defaults for optional settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "123"
    });

    expect(config.geminiCliCommand).toBe("gemini");
    expect(config.geminiOutputFormat).toBe("json");
    expect(config.geminiTimeoutMs).toBe(120_000);
    expect(config.telegramAllowedUserIds.has("123")).toBe(true);
  });
});
