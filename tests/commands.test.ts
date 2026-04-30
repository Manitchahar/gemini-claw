import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AssistantService } from "../src/assistant/assistantService.js";
import { registerCommands, type OperatorCommandOptions } from "../src/bot/commands.js";

type CommandContext = {
  chat?: { id: number | string };
  reply: (text: string) => Promise<void>;
};

type CommandHandler = (ctx: CommandContext) => Promise<void>;

class FakeBot {
  readonly commands = new Map<string, CommandHandler>();

  command(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }
}

const options: OperatorCommandOptions = {
  model: "gemini-test",
  outputFormat: "json",
  yolo: true,
  approvalMode: "auto_edit",
  sandbox: true,
  debug: false,
  allowedTools: ["ReadFile", "Shell"],
  allowedMcpServerNames: ["github"],
  extensions: ["ext-a"],
  includeDirectories: ["src", "tests"],
  settingsConfigured: true
};

describe("registerCommands", () => {
  it("registers the expected operator commands", () => {
    const { bot } = registerTestCommands();

    expect([...bot.commands.keys()]).toEqual(["start", "help", "reset", "status", "tools", "plan", "yolo"]);
  });

  it("lists all commands in help", async () => {
    const reply = await runCommand("help");

    expect(reply).toContain("/start");
    expect(reply).toContain("/help");
    expect(reply).toContain("/reset");
    expect(reply).toContain("/status");
    expect(reply).toContain("/tools");
    expect(reply).toContain("/plan");
    expect(reply).toContain("/yolo");
    expect(reply).toContain("allowlisted Telegram users");
  });

  it("shows safe runtime status", async () => {
    const reply = await runCommand("status");

    expect(reply).toContain("Model: gemini-test");
    expect(reply).toContain("Output format: json");
    expect(reply).toContain("YOLO: enabled");
    expect(reply).toContain("Approval mode: auto_edit");
    expect(reply).toContain("Sandbox: enabled");
    expect(reply).toContain("Debug: disabled");
    expect(reply).toContain("Telegram chat IDs are mapped to Gemini CLI sessions locally");
  });

  it("shows configured tool visibility", async () => {
    const reply = await runCommand("tools");

    expect(reply).toContain("Allowed tools: ReadFile, Shell");
    expect(reply).toContain("Allowed MCP servers: github");
    expect(reply).toContain("Extensions: ext-a");
    expect(reply).toContain("Include directories: src, tests");
    expect(reply).toContain("Settings file: configured");
  });

  it("shows a concise operating plan", async () => {
    const reply = await runCommand("plan");

    expect(reply).toContain("Operating plan:");
    expect(reply).toContain("private allowlisted Telegram messages");
    expect(reply).toContain("YOLO automation enabled");
    expect(reply).toContain("explicit allowlist configured");
  });

  it("shows YOLO state and warning without enabling chat toggles", async () => {
    const reply = await runCommand("yolo");

    expect(reply).toContain("YOLO is currently enabled.");
    expect(reply).toContain("Warning:");
    expect(reply).toContain("GEMINI_YOLO");
    expect(reply).toContain("No chat command toggles are enabled.");
  });

  it("describes default and empty tool configuration clearly", async () => {
    const reply = await runCommand("tools", {
      ...options,
      allowedTools: [],
      allowedMcpServerNames: [],
      extensions: [],
      includeDirectories: [],
      settingsConfigured: false
    });

    expect(reply).toContain("Allowed tools: Gemini CLI default (no explicit allowlist)");
    expect(reply).toContain("Allowed MCP servers: none configured");
    expect(reply).toContain("Extensions: none configured");
    expect(reply).toContain("Include directories: none configured");
    expect(reply).toContain("Settings file: not configured");
  });
});

async function runCommand(command: string, commandOptions: OperatorCommandOptions = options): Promise<string> {
  const { bot } = registerTestCommands(commandOptions);
  const handler = bot.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  await handler({ chat: { id: 123 }, reply });

  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0][0];
}

function registerTestCommands(commandOptions: OperatorCommandOptions = options): { bot: FakeBot } {
  const bot = new FakeBot();
  const assistant = {
    resetChat: vi.fn().mockResolvedValue(undefined)
  };

  registerCommands(bot as unknown as Bot, assistant as unknown as AssistantService, commandOptions);
  return { bot };
}
