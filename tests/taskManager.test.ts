import { describe, expect, it, vi } from "vitest";

import { ChatOperationQueue } from "../src/assistant/chatQueue.js";
import { AssistantTaskManager, TaskQueueFullError } from "../src/assistant/taskManager.js";
import type { AssistantEvent } from "../src/assistant/types.js";
import type { GeminiClient, GeminiClientContext } from "../src/gemini/GeminiClient.js";
import type { SessionRecord, SessionStore } from "../src/storage/SessionStore.js";
import type { TaskStore } from "../src/storage/TaskStore.js";
import type { OperatorLogger } from "../src/utils/operatorLogger.js";
import type { AssistantTaskSummary } from "../src/assistant/types.js";

describe("AssistantTaskManager", () => {
  it("queues tasks beyond the configured worker limit", async () => {
    const gemini = new DeferredGeminiClient();
    const manager = createManager(gemini, { maxWorkers: 1 });

    const first = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "first" });
    const second = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "second" });

    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    await vi.waitFor(() => expect(gemini.contexts).toHaveLength(1));
    expect(manager.getTask("chat-1", first.id)?.status).toBe("running");
    expect(manager.getTask("chat-1", second.id)?.status).toBe("queued");

    gemini.resolveNext([{ type: "content_final", text: "first done" }]);
    await vi.waitFor(() => expect(gemini.contexts).toHaveLength(2));
    expect(manager.getTask("chat-1", first.id)?.status).toBe("succeeded");
    expect(manager.getTask("chat-1", second.id)?.status).toBe("running");
  });

  it("cancels queued tasks without starting Gemini CLI", () => {
    const gemini = new DeferredGeminiClient();
    const manager = createManager(gemini, { maxWorkers: 0 as never });

    const task = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "queued" });
    const cancelled = manager.cancelTask("chat-1", task.id);

    expect(cancelled?.status).toBe("cancelled");
    expect(gemini.contexts).toHaveLength(0);
  });

  it("records observed tools and possible subagents for completed tasks", async () => {
    const gemini = new ImmediateGeminiClient([
      { type: "tool_start", name: "RunSubAgent", possibleSubagentName: "research-agent" },
      { type: "tool_end", name: "RunSubAgent", success: true, possibleSubagentName: "research-agent" },
      { type: "content_final", text: "done" }
    ]);
    const manager = createManager(gemini);

    const task = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "research" });

    await vi.waitFor(() => expect(manager.getTask("chat-1", task.id)?.status).toBe("succeeded"));
    expect(manager.getTask("chat-1", task.id)).toMatchObject({
      tools: ["RunSubAgent"],
      possibleSubagents: ["research-agent"],
      response: "done"
    });
    expect(manager.getSubagentStatus("chat-1").observedSubagents).toEqual(["research-agent"]);
  });

  it("logs task lifecycle, tools, and observed subagents", async () => {
    const logger = createCaptureLogger();
    const gemini = new ImmediateGeminiClient([
      { type: "tool_start", name: "RunSubAgent", possibleSubagentName: "research-agent" },
      { type: "tool_end", name: "RunSubAgent", success: true, possibleSubagentName: "research-agent" },
      { type: "content_final", text: "done" }
    ]);
    const manager = createManager(gemini, { logger });

    const task = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "research this repo" });

    await vi.waitFor(() => expect(manager.getTask("chat-1", task.id)?.status).toBe("succeeded"));
    expect(logger.info).toHaveBeenCalledWith("task_queued", expect.objectContaining({ id: task.id, preview: "research this repo" }));
    expect(logger.info).toHaveBeenCalledWith("task_running", expect.objectContaining({ id: task.id }));
    expect(logger.info).toHaveBeenCalledWith("tool_start", expect.objectContaining({ id: task.id, name: "RunSubAgent" }));
    expect(logger.info).toHaveBeenCalledWith("subagent", expect.objectContaining({ id: task.id, name: "research-agent" }));
    expect(logger.info).toHaveBeenCalledWith("task_completed", expect.objectContaining({ id: task.id, chars: 4, tools: 1 }));
  });

  it("rejects tasks when the per-chat queue is full", () => {
    const gemini = new DeferredGeminiClient();
    const manager = createManager(gemini, { maxWorkers: 0 as never, maxChatQueuedTasks: 1 });

    manager.startTask({ chatId: "chat-1", userId: "user-1", text: "first" });

    expect(() => manager.startTask({ chatId: "chat-1", userId: "user-1", text: "second" })).toThrow(
      TaskQueueFullError
    );
  });

  it("serializes same-chat workers when using the shared chat session mode", async () => {
    const gemini = new DeferredGeminiClient();
    const manager = createManager(gemini, { maxWorkers: 2, maxChatWorkers: 2, workerSessionMode: "chat" });

    const first = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "first" });
    const second = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "second" });

    await vi.waitFor(() => expect(gemini.contexts).toHaveLength(1));
    expect(manager.getTask("chat-1", first.id)?.status).toBe("running");
    expect(manager.getTask("chat-1", second.id)?.status).toBe("queued");
    expect(manager.getWorkerStats().maxChatWorkers).toBe(1);
  });

  it("serializes chat-session workers behind foreground chat operations", async () => {
    const gemini = new DeferredGeminiClient();
    const sharedChatQueue = new ChatOperationQueue();
    let releaseForeground!: () => void;
    const foreground = sharedChatQueue.run(
      "chat-1",
      () =>
        new Promise<void>((resolve) => {
          releaseForeground = resolve;
        })
    );
    const manager = createManager(gemini, { workerSessionMode: "chat", sharedChatQueue });

    manager.startTask({ chatId: "chat-1", userId: "user-1", text: "queued behind foreground" });

    await vi.waitFor(() => expect(manager.getWorkerStats().running).toBe(1));
    expect(gemini.contexts).toHaveLength(0);
    releaseForeground();
    await foreground;
    await vi.waitFor(() => expect(gemini.contexts).toHaveLength(1));
  });

  it("pauses new workers and resumes queued work", async () => {
    const gemini = new DeferredGeminiClient();
    const manager = createManager(gemini);

    manager.pause();
    const task = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "queued while paused" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getWorkerStats().paused).toBe(true);
    expect(manager.getTask("chat-1", task.id)?.status).toBe("queued");
    expect(gemini.contexts).toHaveLength(0);

    manager.resume();
    await vi.waitFor(() => expect(gemini.contexts).toHaveLength(1));
    expect(manager.getWorkerStats().paused).toBe(false);
  });

  it("persists task updates and restores interrupted tasks as failed", async () => {
    const taskStore = new MemoryTaskStore([
      {
        id: "t-0007",
        chatId: "chat-1",
        userId: "user-1",
        text: "old running task",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        tools: [],
        failedTools: [],
        possibleSubagents: []
      }
    ]);
    const manager = createManager(new ImmediateGeminiClient([{ type: "content_final", text: "done" }]), { taskStore });

    expect(manager.getTask("chat-1", "t-0007")).toMatchObject({
      status: "failed",
      error: "Task was interrupted before this process started."
    });

    const task = manager.startTask({ chatId: "chat-1", userId: "user-1", text: "new task" });
    await vi.waitFor(() => expect(manager.getTask("chat-1", task.id)?.status).toBe("succeeded"));
    expect(taskStore.lastSaved.some((saved) => saved.id === task.id && saved.response === "done")).toBe(true);
  });
});

function createManager(
  geminiClient: GeminiClient,
  overrides: Partial<ConstructorParameters<typeof AssistantTaskManager>[2]> = {}
): AssistantTaskManager {
  return new AssistantTaskManager(geminiClient, new MemorySessionStore(), {
    systemInstruction: "Be useful.",
    maxWorkers: 2,
    maxChatWorkers: 2,
    maxQueuedTasks: 50,
    maxChatQueuedTasks: 10,
    historyLimit: 20,
    workerSessionMode: "isolated",
    extensions: ["ext-a"],
    ...overrides
  });
}

class ImmediateGeminiClient implements GeminiClient {
  constructor(private readonly events: AssistantEvent[]) {}

  async *sendMessage(_input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    yield* this.events;
  }
}

class DeferredGeminiClient implements GeminiClient {
  readonly contexts: GeminiClientContext[] = [];
  private readonly pending: Array<(events: AssistantEvent[]) => void> = [];

  async *sendMessage(_input: string, context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    this.contexts.push(context);
    const events = await new Promise<AssistantEvent[]>((resolve) => {
      this.pending.push(resolve);
    });
    yield* events;
  }

  resolveNext(events: AssistantEvent[]): void {
    const resolve = this.pending.shift();
    if (!resolve) {
      throw new Error("No pending Gemini call.");
    }
    resolve(events);
  }
}

class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async getSession(chatId: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(chatId);
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.chatId, record);
  }

  async deleteSession(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }
}

class MemoryTaskStore implements TaskStore {
  lastSaved: AssistantTaskSummary[];

  constructor(private readonly initial: AssistantTaskSummary[] = []) {
    this.lastSaved = initial;
  }

  loadTasks(): AssistantTaskSummary[] {
    return this.initial;
  }

  saveTasks(tasks: readonly AssistantTaskSummary[]): void {
    this.lastSaved = [...tasks];
  }
}

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
