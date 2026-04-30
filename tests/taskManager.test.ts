import { describe, expect, it, vi } from "vitest";

import { ChatOperationQueue } from "../src/assistant/chatQueue.js";
import { AssistantTaskManager, TaskQueueFullError } from "../src/assistant/taskManager.js";
import type { AssistantEvent } from "../src/assistant/types.js";
import type { GeminiClient, GeminiClientContext } from "../src/gemini/GeminiClient.js";
import type { SessionRecord, SessionStore } from "../src/storage/SessionStore.js";

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
