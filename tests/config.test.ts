import { describe, expect, it } from "vitest";

import { loadConfig, parseAllowedUserIds, parseBooleanConfig, parseCommaSeparatedList } from "../src/config.js";
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
    expect(config.geminiOutputFormat).toBe("stream-json");
    expect(config.geminiTimeoutMs).toBe(120_000);
    expect(config.telegramAllowedUserIds.has("123")).toBe(true);
    expect(config.geminiYolo).toBe(true);
    expect(config.geminiApprovalMode).toBeUndefined();
    expect(config.geminiSandbox).toBe(false);
    expect(config.geminiDebug).toBe(false);
    expect(config.geminiTrustWorkspace).toBe(true);
    expect(config.geminiCwd).toBeUndefined();
    expect(config.geminiAllowedTools).toEqual([]);
    expect(config.geminiAllowedMcpServerNames).toEqual([]);
    expect(config.geminiExtensions).toEqual([]);
    expect(config.geminiIncludeDirectories).toEqual([]);
    expect(config.geminiSettings).toBeUndefined();
    expect(config.geminiMaxWorkers).toBe(3);
    expect(config.geminiMaxChatWorkers).toBe(3);
    expect(config.geminiMaxQueuedTasks).toBe(50);
    expect(config.geminiMaxChatQueuedTasks).toBe(10);
    expect(config.geminiTaskHistoryLimit).toBe(20);
    expect(config.geminiWorkerSessionMode).toBe("isolated");
    expect(config.operatorLogStyle).toBe("pretty");
    expect(config.operatorLogLevel).toBe("info");
    expect(config.operatorLogContent).toBe(false);
    expect(config.operatorLogPreviewChars).toBe(120);
    expect(config.taskStorePath).toBe(".data/tasks.json");
  });

  it.each(["true", "1", "yes", "on", " TRUE "])("parses %s as true", (value) => {
    expect(parseBooleanConfig(value, "TEST_BOOLEAN")).toBe(true);
  });

  it.each(["false", "0", "no", "off", " FALSE "])("parses %s as false", (value) => {
    expect(parseBooleanConfig(value, "TEST_BOOLEAN", true)).toBe(false);
  });

  it("rejects invalid boolean values", () => {
    expect(() => parseBooleanConfig("maybe", "TEST_BOOLEAN")).toThrow(ConfigurationError);
  });

  it("keeps Gemini YOLO enabled regardless of legacy GEMINI_YOLO env values", () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        GEMINI_YOLO: "false"
      }).geminiYolo
    ).toBe(true);
  });

  it("parses comma-separated lists by trimming and dropping empty entries", () => {
    expect(parseCommaSeparatedList(" read_file, , run_shell,write_file ,, ")).toEqual([
      "read_file",
      "run_shell",
      "write_file"
    ]);
    expect(parseCommaSeparatedList(undefined)).toEqual([]);
  });

  it("loads Gemini automation settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      GEMINI_APPROVAL_MODE: "auto_edit",
      GEMINI_SANDBOX: "on",
      GEMINI_DEBUG: "1",
      GEMINI_TRUST_WORKSPACE: "false",
      GEMINI_CWD: " /workspace/project ",
      GEMINI_ALLOWED_TOOLS: "read_file, run_shell, ,write_file",
      GEMINI_ALLOWED_MCP_SERVER_NAMES: "github, filesystem",
      GEMINI_EXTENSIONS: "ext-a, ext-b",
      GEMINI_INCLUDE_DIRECTORIES: "src, tests",
      GEMINI_SETTINGS: " settings.json ",
      GEMINI_MAX_WORKERS: "5",
      GEMINI_MAX_CHAT_WORKERS: "2",
      GEMINI_MAX_QUEUED_TASKS: "25",
      GEMINI_MAX_CHAT_QUEUED_TASKS: "7",
      GEMINI_TASK_HISTORY_LIMIT: "50",
      GEMINI_WORKER_SESSION_MODE: "chat",
      OPERATOR_LOG_STYLE: "json",
      OPERATOR_LOG_LEVEL: "debug",
      OPERATOR_LOG_CONTENT: "true",
      OPERATOR_LOG_PREVIEW_CHARS: "80"
    });

    expect(config.geminiYolo).toBe(true);
    expect(config.geminiApprovalMode).toBe("auto_edit");
    expect(config.geminiSandbox).toBe(true);
    expect(config.geminiDebug).toBe(true);
    expect(config.geminiTrustWorkspace).toBe(false);
    expect(config.geminiCwd).toBe("/workspace/project");
    expect(config.geminiAllowedTools).toEqual(["read_file", "run_shell", "write_file"]);
    expect(config.geminiAllowedMcpServerNames).toEqual(["github", "filesystem"]);
    expect(config.geminiExtensions).toEqual(["ext-a", "ext-b"]);
    expect(config.geminiIncludeDirectories).toEqual(["src", "tests"]);
    expect(config.geminiSettings).toBe("settings.json");
    expect(config.geminiMaxWorkers).toBe(5);
    expect(config.geminiMaxChatWorkers).toBe(2);
    expect(config.geminiMaxQueuedTasks).toBe(25);
    expect(config.geminiMaxChatQueuedTasks).toBe(7);
    expect(config.geminiTaskHistoryLimit).toBe(50);
    expect(config.geminiWorkerSessionMode).toBe("chat");
    expect(config.operatorLogStyle).toBe("json");
    expect(config.operatorLogLevel).toBe("debug");
    expect(config.operatorLogContent).toBe(true);
    expect(config.operatorLogPreviewChars).toBe(80);
  });

  it("rejects invalid operator logging settings", () => {
    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        OPERATOR_LOG_STYLE: "rainbow"
      })
    ).toThrow(ConfigurationError);

    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        OPERATOR_LOG_CONTENT: "maybe"
      })
    ).toThrow(ConfigurationError);
  });
});
