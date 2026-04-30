import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGeminiCliArgs,
  CliGeminiClient,
  parseGeminiJsonOutput,
  parseGeminiStreamJsonOutput
} from "../src/gemini/CliGeminiClient.js";
import { GeminiCliError } from "../src/utils/errors.js";
import type { OperatorLogger } from "../src/utils/operatorLogger.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn()
}));

const spawnMock = vi.mocked(spawn);

function mockGeminiCli(stdout: string): void {
  spawnMock.mockImplementationOnce((() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };

    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.kill = vi.fn();

    queueMicrotask(() => {
      child.stdout.emit("data", stdout);
      child.emit("close", 0);
    });

    return child;
  }) as never);
}

async function collectEvents(client: CliGeminiClient): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of client.sendMessage("hello", { chatId: "1", userId: "2" })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("CliGeminiClient parsers", () => {
  it("builds resume args for persisted Gemini sessions", () => {
    expect(
      buildGeminiCliArgs("hello", {
        outputFormat: "json",
        model: "gemini-test",
        sessionId: "session-1"
      })
    ).toEqual(["--prompt", "hello", "--output-format", "json", "--model", "gemini-test", "--resume", "session-1"]);
  });

  it("parses simple JSON responses", () => {
    const events = parseGeminiJsonOutput(JSON.stringify({ response: "Hello there", sessionId: "session-1" }));

    expect(events).toContainEqual({ type: "content_final", text: "Hello there" });
    expect(events).toContainEqual({ type: "stats", sessionId: "session-1", raw: { response: "Hello there", sessionId: "session-1" } });
  });

  it("ignores Gemini CLI stdout diagnostics before JSON responses", () => {
    const events = parseGeminiJsonOutput(
      `MCP issues detected. Run /mcp list for status.${JSON.stringify({ response: "Still JSON", session_id: "session-1" })}`
    );

    expect(events).toContainEqual({ type: "content_final", text: "Still JSON" });
    expect(events).toContainEqual({
      type: "stats",
      sessionId: "session-1",
      raw: { response: "Still JSON", session_id: "session-1" }
    });
  });

  it("uses the final JSON payload when stdout includes earlier JSON diagnostics", () => {
    const events = parseGeminiJsonOutput(
      `${JSON.stringify({ role: "user", text: "do not echo" })}${JSON.stringify({
        response: "Actual answer",
        session_id: "session-1"
      })}`
    );

    expect(events).toContainEqual({ type: "content_final", text: "Actual answer" });
  });

  it("parses nested JSON responses", () => {
    const events = parseGeminiJsonOutput(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "Nested response" }]
            }
          }
        ]
      })
    );

    expect(events[0]).toEqual({ type: "content_final", text: "Nested response" });
  });

  it("throws on structured JSON errors", () => {
    expect(() => parseGeminiJsonOutput(JSON.stringify({ error: { message: "no auth" } }))).toThrow(GeminiCliError);
  });

  it("parses stream-json assistant message events", () => {
    const output = [
      JSON.stringify({ type: "message", role: "user", text: "ignore me" }),
      JSON.stringify({ type: "message", role: "assistant", text: "Hello " }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "there" } }),
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "content_delta", text: "Hello " },
      { type: "content_delta", text: "there" },
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });

  it("normalizes stream-json init events into stats", () => {
    expect(parseGeminiStreamJsonOutput(JSON.stringify({ type: "init", sessionId: "init-session", model: "gemini-test" }))).toEqual([
      { type: "stats", sessionId: "init-session", raw: { type: "init", sessionId: "init-session", model: "gemini-test" } }
    ]);
  });

  it("normalizes stream-json tool_use events into tool_start", () => {
    const raw = { type: "tool_use", toolName: "ReadFile" };
    expect(parseGeminiStreamJsonOutput(JSON.stringify(raw))).toEqual([{ type: "tool_start", name: "ReadFile", raw }]);
  });

  it("normalizes successful stream-json tool_result events into tool_end", () => {
    const raw = { type: "tool_result", tool_name: "ReadFile", result: "ok" };
    expect(parseGeminiStreamJsonOutput(JSON.stringify(raw))).toEqual([{ type: "tool_end", name: "ReadFile", success: true, raw }]);
  });

  it("normalizes failing stream-json tool_result events without throwing", () => {
    const raw = { type: "tool_result", name: "ReadFile", error: { message: "missing" } };
    expect(parseGeminiStreamJsonOutput(JSON.stringify(raw))).toEqual([{ type: "tool_end", name: "ReadFile", success: false, raw }]);
  });

  it("records possible subagent names from stream-json tool events", () => {
    const raw = { type: "tool_use", toolName: "RunSubAgent", agentName: "research-agent" };
    expect(parseGeminiStreamJsonOutput(JSON.stringify(raw))).toEqual([
      { type: "tool_start", name: "RunSubAgent", raw, possibleSubagentName: "research-agent" }
    ]);
  });

  it("normalizes result session id variants into stats", () => {
    const output = [
      JSON.stringify({ type: "result", sessionId: "session-camel" }),
      JSON.stringify({ type: "result", session_id: "session-snake" }),
      JSON.stringify({ type: "result", conversationId: "conversation-camel" }),
      JSON.stringify({ type: "result", conversation_id: "conversation-snake" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "stats", sessionId: "session-camel", raw: { type: "result", sessionId: "session-camel" } },
      { type: "stats", sessionId: "session-snake", raw: { type: "result", session_id: "session-snake" } },
      { type: "stats", sessionId: "conversation-camel", raw: { type: "result", conversationId: "conversation-camel" } },
      { type: "stats", sessionId: "conversation-snake", raw: { type: "result", conversation_id: "conversation-snake" } }
    ]);
  });

  it("keeps final stream-json events final", () => {
    expect(parseGeminiStreamJsonOutput(JSON.stringify({ type: "content_final", text: "Finished" }))).toEqual([
      { type: "content_final", text: "Finished" }
    ]);
  });

  it("buffers pretty-printed stream JSON objects", () => {
    const output = JSON.stringify({ type: "message", role: "assistant", text: "Pretty" }, null, 2);

    expect(parseGeminiStreamJsonOutput(output)).toEqual([{ type: "content_delta", text: "Pretty" }]);
  });

  it("ignores Gemini CLI stdout diagnostics before stream-json events", () => {
    const output = [
      `MCP issues detected. Run /mcp list for status.${JSON.stringify({ type: "message", role: "assistant", text: "Hello" })}`,
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "content_delta", text: "Hello" },
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });

  it("throws on stream-json error events", () => {
    expect(() => parseGeminiStreamJsonOutput(JSON.stringify({ type: "error", error: { message: "boom" } }))).toThrow(
      GeminiCliError
    );
  });

  it("throws on stream-json structured errors without explicit error event types", () => {
    expect(() => parseGeminiStreamJsonOutput(JSON.stringify({ error: { message: "no auth" } }))).toThrow(GeminiCliError);
  });

  it("does not fall back to echoing user stream messages", () => {
    expect(parseGeminiStreamJsonOutput(JSON.stringify({ type: "message", role: "user", text: "do not echo" }))).toEqual([]);
  });

  it("does not fall back to echoing bare non-assistant stream records", () => {
    const output = [
      JSON.stringify({ role: "user", text: "do not echo" }),
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });
});

describe("buildGeminiCliArgs", () => {
  it("omits automation flags by default", () => {
    expect(buildGeminiCliArgs("hello", { outputFormat: "json" })).toEqual(["--prompt", "hello", "--output-format", "json"]);
  });

  it("emits yolo, debug, and sandbox booleans when enabled", () => {
    expect(buildGeminiCliArgs("hello", { outputFormat: "json", yolo: true, debug: true, sandbox: true })).toEqual([
      "--prompt",
      "hello",
      "--output-format",
      "json",
      "--yolo",
      "--sandbox",
      "--debug"
    ]);
  });

  it("emits list flags as comma-separated values", () => {
    expect(
      buildGeminiCliArgs("hello", {
        outputFormat: "json",
        allowedTools: ["ReadFile", "Shell"],
        allowedMcpServerNames: ["github", "filesystem"],
        extensions: ["ext-a", "ext-b"],
        includeDirectories: ["src", "tests"]
      })
    ).toEqual([
      "--prompt",
      "hello",
      "--output-format",
      "json",
      "--allowed-tools",
      "ReadFile,Shell",
      "--allowed-mcp-server-names",
      "github,filesystem",
      "--extensions",
      "ext-a,ext-b",
      "--include-directories",
      "src,tests"
    ]);
  });

  it("emits approval mode and settings", () => {
    expect(
      buildGeminiCliArgs("hello", {
        outputFormat: "json",
        approvalMode: "auto_edit",
        settings: ".gemini/settings.json"
      })
    ).toEqual([
      "--prompt",
      "hello",
      "--output-format",
      "json",
      "--approval-mode",
      "auto_edit",
      "--settings",
      ".gemini/settings.json"
    ]);
  });

  it("emits combined automation flags after existing prompt, output, model, and resume args", () => {
    expect(
      buildGeminiCliArgs("hello", {
        outputFormat: "stream-json",
        model: "gemini-test",
        sessionId: "session-1",
        yolo: true,
        approvalMode: "yolo",
        sandbox: true,
        debug: true,
        allowedTools: ["ReadFile", "Shell"],
        allowedMcpServerNames: ["github"],
        extensions: ["ext-a"],
        includeDirectories: ["src"],
        settings: "settings.json"
      })
    ).toEqual([
      "--prompt",
      "hello",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-test",
      "--resume",
      "session-1",
      "--yolo",
      "--approval-mode",
      "yolo",
      "--sandbox",
      "--debug",
      "--allowed-tools",
      "ReadFile,Shell",
      "--allowed-mcp-server-names",
      "github",
      "--extensions",
      "ext-a",
      "--include-directories",
      "src",
      "--settings",
      "settings.json"
    ]);
  });
});

describe("CliGeminiClient", () => {
  it("preserves default spawn options when cwd is not configured", async () => {
    mockGeminiCli(JSON.stringify({ response: "done" }));

    const client = new CliGeminiClient({
      command: "gemini",
      outputFormat: "json",
      timeoutMs: 1_000
    });

    await expect(collectEvents(client)).resolves.toContainEqual({ type: "content_final", text: "done" });
    expect(spawnMock).toHaveBeenCalledWith(
      "gemini",
      ["--prompt", "hello", "--output-format", "json"],
      expect.not.objectContaining({ cwd: expect.any(String) })
    );
  });

  it("passes configured cwd into spawn options", async () => {
    mockGeminiCli(JSON.stringify({ response: "done" }));

    const client = new CliGeminiClient({
      command: "gemini",
      outputFormat: "json",
      timeoutMs: 1_000,
      cwd: "/workspace/project"
    });

    await expect(collectEvents(client)).resolves.toContainEqual({ type: "content_final", text: "done" });
    expect(spawnMock).toHaveBeenCalledWith(
      "gemini",
      ["--prompt", "hello", "--output-format", "json"],
      expect.objectContaining({ cwd: "/workspace/project" })
    );
  });

  it("logs Gemini CLI subprocess lifecycle without raw stdout", async () => {
    mockGeminiCli(JSON.stringify({ response: "done" }));
    const logger = createCaptureLogger();

    const client = new CliGeminiClient({
      command: "gemini",
      outputFormat: "json",
      timeoutMs: 1_000,
      logger
    });

    await expect(collectEvents(client)).resolves.toContainEqual({ type: "content_final", text: "done" });
    expect(logger.info).toHaveBeenCalledWith(
      "gemini_start",
      expect.objectContaining({ chat: "1", user: "2", output: "json", prompt_chars: 5, preview: "hello" })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "gemini_done",
      expect.objectContaining({ chat: "1", status: "ok", stdout_chars: JSON.stringify({ response: "done" }).length })
    );
  });
});

function createCaptureLogger(): OperatorLogger {
  return {
    includeContent: false,
    preview: vi.fn((value: string | undefined) => value),
    banner: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  };
}
