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
      "demo_check",
      "task",
      "tasks",
      "task_status",
      "cancel",
      "stop_all",
      "pause",
      "resume",
      "workers",
      "sessions",
      "delete_session",
      "mcp",
      "extensions",
      "skills",
      "skill_link",
      "skill_install",
      "skill_enable",
      "skill_disable",
      "skill_uninstall",
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
    expect(reply).toContain("/demo_check");
    expect(reply).toContain("/task <prompt>");
    expect(reply).toContain("/stop_all");
    expect(reply).toContain("/sessions");
    expect(reply).toContain("/mcp");
    expect(reply).toContain("/extensions");
    expect(reply).toContain("/skills");
    expect(reply).toContain("/skill_link");
    expect(reply).toContain("/skill_install");
    expect(reply).toContain("/skill_enable");
    expect(reply).toContain("/skill_disable");
    expect(reply).toContain("/skill_uninstall");
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
    expect(reply).toContain("YOLO automation is always enabled");
    expect(reply).toContain("runs with --yolo for every request");
    expect(reply).toContain("explicit allowlist configured");
    expect(reply).toContain("Workers: 3 total, 2 per chat, isolated sessions.");
    expect(reply).toContain("/status for runtime settings");
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
    const workers = await runCommand("workers");
    expect(workers).toContain("Running: 1/3");
    expect(workers).toContain("Paused: disabled");
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

  it("exposes Gemini CLI management commands", async () => {
    const { bot, assistant } = registerTestCommands();
    const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await bot.commands.get("sessions")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/sessions" }, reply });
    await bot.commands.get("mcp")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/mcp" }, reply });
    await bot.commands.get("extensions")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/extensions" }, reply });
    await bot.commands.get("skills")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skills" }, reply });
    await bot.commands
      .get("delete_session")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/delete_session 3" }, reply });

    expect(assistant.listGeminiSessions).toHaveBeenCalledWith("123", "456");
    expect(assistant.listGeminiMcpServers).toHaveBeenCalledWith("123", "456");
    expect(assistant.listGeminiExtensions).toHaveBeenCalledWith("123", "456");
    expect(assistant.listGeminiSkills).toHaveBeenCalledWith("123", "456");
    expect(assistant.deleteGeminiSession).toHaveBeenCalledWith("123", "456", "3");
  });

  it("exposes Gemini CLI skill management commands", async () => {
    const { bot, assistant } = registerTestCommands();
    const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await bot.commands
      .get("skill_link")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skill_link .data/skill" }, reply });
    await bot.commands
      .get("skill_install")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skill_install https://example.com/skill.git" }, reply });
    await bot.commands
      .get("skill_enable")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skill_enable test-skill" }, reply });
    await bot.commands
      .get("skill_disable")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skill_disable test-skill" }, reply });
    await bot.commands
      .get("skill_uninstall")
      ?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/skill_uninstall test-skill" }, reply });

    expect(assistant.linkGeminiSkill).toHaveBeenCalledWith("123", "456", ".data/skill");
    expect(assistant.installGeminiSkill).toHaveBeenCalledWith("123", "456", "https://example.com/skill.git");
    expect(assistant.enableGeminiSkill).toHaveBeenCalledWith("123", "456", "test-skill");
    expect(assistant.disableGeminiSkill).toHaveBeenCalledWith("123", "456", "test-skill");
    expect(assistant.uninstallGeminiSkill).toHaveBeenCalledWith("123", "456", "test-skill");
  });

  it("supports panic controls", async () => {
    const { bot, assistant } = registerTestCommands();
    const reply = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

    await bot.commands.get("pause")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/pause" }, reply });
    await bot.commands.get("resume")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/resume" }, reply });
    await bot.commands.get("stop_all")?.({ chat: { id: 123 }, from: { id: 456 }, message: { text: "/stop_all" }, reply });

    expect(assistant.pauseWorkers).toHaveBeenCalled();
    expect(assistant.resumeWorkers).toHaveBeenCalled();
    expect(assistant.stopAllTasks).toHaveBeenCalledWith("123");
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
      runningTaskIds: ["t-0001"],
      paused: false
    }),
    getSubagentStatus: vi.fn().mockReturnValue({
      extensionsConfigured: true,
      configuredExtensions: ["ext-a"],
      observedSubagents: ["research-agent"]
    }),
    pauseWorkers: vi.fn().mockReturnValue({
      maxWorkers: 3,
      maxChatWorkers: 2,
      maxQueuedTasks: 50,
      maxChatQueuedTasks: 10,
      running: 1,
      queued: 0,
      runningTaskIds: ["t-0001"],
      paused: true
    }),
    resumeWorkers: vi.fn().mockReturnValue({
      maxWorkers: 3,
      maxChatWorkers: 2,
      maxQueuedTasks: 50,
      maxChatQueuedTasks: 10,
      running: 1,
      queued: 0,
      runningTaskIds: ["t-0001"],
      paused: false
    }),
    stopAllTasks: vi.fn().mockReturnValue([
      {
        id: "t-0001",
        chatId: "123",
        userId: "456",
        text: "inspect repo",
        status: "running",
        createdAt: "now",
        tools: [],
        failedTools: [],
        possibleSubagents: []
      }
    ]),
    listGeminiSessions: vi.fn().mockResolvedValue("sessions"),
    deleteGeminiSession: vi.fn().mockResolvedValue("deleted"),
    listGeminiMcpServers: vi.fn().mockResolvedValue("mcp"),
    listGeminiExtensions: vi.fn().mockResolvedValue("extensions"),
    listGeminiSkills: vi.fn().mockResolvedValue("skills"),
    linkGeminiSkill: vi.fn().mockResolvedValue("linked"),
    installGeminiSkill: vi.fn().mockResolvedValue("installed"),
    enableGeminiSkill: vi.fn().mockResolvedValue("enabled"),
    disableGeminiSkill: vi.fn().mockResolvedValue("disabled"),
    uninstallGeminiSkill: vi.fn().mockResolvedValue("uninstalled")
  };

  registerCommands(bot as unknown as Bot, assistant as unknown as AssistantService, commandOptions);
  return { bot, assistant };
}
