import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AssistantService } from "../src/assistant/assistantService.js";
import { registerCommands, type OperatorCommandOptions } from "../src/bot/commands.js";

type CommandContext = {
  chat?: { id: number | string };
  from?: { id: number | string };
  message?: { text?: string };
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
  settingsConfigured: true,
  maxWorkers: 3,
  maxChatWorkers: 2,
  maxQueuedTasks: 50,
  maxChatQueuedTasks: 10,
  taskHistoryLimit: 20,
  workerSessionMode: "isolated",
  responseChunkSize: 3900
};

describe("registerCommands", () => {
  it("registers the expected operator commands", () => {
    const { bot } = registerTestCommands();

    expect([...bot.commands.keys()]).toEqual([
      "start",
      "help",
      "reset",
      "status",
      "tools",
      "plan",
      "yolo",
      "task",
      "tasks",
      "task_status",
      "cancel",
      "workers",
      "subagents"
    ]);
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
    expect(reply).toContain("/task <prompt>");
    expect(reply).toContain("/workers");
    expect(reply).toContain("/subagents");
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
    expect(reply).toContain("Workers: 3 total, 2 per chat");
    expect(reply).toContain("Telegram chat IDs are mapped to Gemini CLI sessions locally");
  });

  it("shows configured tool visibility", async () => {
    const reply = await runCommand("tools");

    expect(reply).toContain("Allowed tools: ReadFile, Shell");
    expect(reply).toContain("Allowed MCP servers: github");
    expect(reply).toContain("Extensions: ext-a");
    expect(reply).toContain("Include directories: src, tests");
    expect(reply).toContain("Settings file: configured");
    expect(reply).toContain("Subagents: available only");
  });

  it("shows a concise operating plan", async () => {
    const reply = await runCommand("plan");

    expect(reply).toContain("Operating plan:");
    expect(reply).toContain("private allowlisted Telegram messages");
    expect(reply).toContain("YOLO automation enabled");
    expect(reply).toContain("explicit allowlist configured");
    expect(reply).toContain("Workers: 3 total, 2 per chat, isolated sessions.");
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

  it("starts background tasks from Telegram", async () => {
    const { bot, assistant } = registerTestCommands();
    const handler = bot.commands.get("task");
    if (!handler) throw new Error("task command not registered");
    const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await handler({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/task inspect repo" }, reply });

    expect(assistant.startTask).toHaveBeenCalledWith(
      { chatId: "123", userId: "456", text: "inspect repo" },
      expect.objectContaining({ onComplete: expect.any(Function) })
    );
    expect(reply).toHaveBeenCalledWith("Started task t-0001. Use /task_status t-0001 to check it.");
  });

  it("shows worker and subagent status", async () => {
    expect(await runCommand("workers")).toContain("Running: 1/3");
    const subagents = await runCommand("subagents");
    expect(subagents).toContain("SDK default: not available.");
    expect(subagents).toContain("Observed subagents: research-agent");
  });

  it("reports cancellation requested for running tasks", async () => {
    const { bot, assistant } = registerTestCommands();
    assistant.cancelTask.mockReturnValueOnce({
      id: "t-0001",
      chatId: "123",
      userId: "456",
      text: "inspect repo",
      status: "running",
      createdAt: "now",
      tools: [],
      failedTools: [],
      possibleSubagents: []
    });
    const handler = bot.commands.get("cancel");
    if (!handler) throw new Error("cancel command not registered");
    const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await handler({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/cancel t-0001" }, reply });

    expect(reply).toHaveBeenCalledWith("Cancellation requested for task t-0001.");
  });
});

async function runCommand(command: string, commandOptions: OperatorCommandOptions = options): Promise<string> {
  const { bot } = registerTestCommands(commandOptions);
  const handler = bot.commands.get(command);
  if (!handler) {
    throw new Error(`Command not registered: ${command}`);
  }

  const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  await handler({ chat: { id: 123 }, from: { id: 456 }, message: { text: `/${command}` }, reply });

  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0][0];
}

function registerTestCommands(commandOptions: OperatorCommandOptions = options): { bot: FakeBot; assistant: Record<string, ReturnType<typeof vi.fn>> } {
  const bot = new FakeBot();
  const assistant = {
    resetChat: vi.fn().mockResolvedValue(undefined),
    startTask: vi.fn().mockReturnValue({
      id: "t-0001",
      chatId: "123",
      userId: "456",
      text: "inspect repo",
      status: "queued",
      createdAt: "now",
      tools: [],
      failedTools: [],
      possibleSubagents: []
    }),
    listTasks: vi.fn().mockReturnValue([
      {
        id: "t-0001",
        chatId: "123",
        userId: "456",
        text: "inspect repo",
        status: "running",
        createdAt: "now",
        tools: ["ReadFile"],
        failedTools: [],
        possibleSubagents: []
      }
    ]),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    getWorkerStats: vi.fn().mockReturnValue({
      maxWorkers: 3,
      maxChatWorkers: 2,
      maxQueuedTasks: 50,
      maxChatQueuedTasks: 10,
      running: 1,
      queued: 0,
      runningTaskIds: ["t-0001"]
    }),
    getSubagentStatus: vi.fn().mockReturnValue({
      extensionsConfigured: true,
      configuredExtensions: ["ext-a"],
      observedSubagents: ["research-agent"]
    })
  };

  registerCommands(bot as unknown as Bot, assistant as unknown as AssistantService, commandOptions);
  return { bot, assistant };
}
