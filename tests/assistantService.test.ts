import { describe, expect, it, vi } from "vitest";

import { AssistantService } from "../src/assistant/assistantService.js";
import type { AssistantEvent } from "../src/assistant/types.js";
import type { GeminiClient, GeminiClientContext } from "../src/gemini/GeminiClient.js";
import type { SessionRecord, SessionStore } from "../src/storage/SessionStore.js";

describe("AssistantService", () => {
  it("passes Telegram messages to Gemini and stores session metadata", async () => {
    const gemini = new FakeGeminiClient([
      { type: "content_final", text: "Done" },
      { type: "stats", sessionId: "session-1" }
    ]);
    const store = new MemorySessionStore();
    const service = new AssistantService(gemini, store, {
      systemInstruction: "Be useful."
    });

    const response = await service.respondToText({
      chatId: "chat-1",
      userId: "user-1",
      text: "hello"
    });

    expect(response).toBe("Done");
    expect(gemini.lastInput).toContain("User message:\nhello");
    expect(await store.getSession("chat-1")).toMatchObject({
      chatId: "chat-1",
      userId: "user-1",
      geminiSessionId: "session-1"
    });
  });

  it("serializes reset behind in-flight responses so reset wins", async () => {
    const gemini = new DeferredGeminiClient();
    const store = new MemorySessionStore();
    const service = new AssistantService(gemini, store, {
      systemInstruction: "Be useful."
    });

    const responsePromise = service.respondToText({
      chatId: "chat-1",
      userId: "user-1",
      text: "hello"
    });
    const resetPromise = service.resetChat("chat-1");

    gemini.resolve([
      { type: "content_final", text: "Done" },
      { type: "stats", sessionId: "session-1" }
    ]);

    await expect(responsePromise).resolves.toBe("Done");
    await resetPromise;
    expect(await store.getSession("chat-1")).toBeUndefined();
  });

  it("surfaces tool progress events through the request callback without changing the final response", async () => {
    const gemini = new FakeGeminiClient([
      { type: "tool_start", name: "ReadFile" },
      { type: "content_delta", text: "Do" },
      { type: "content_delta", text: "ne" },
      { type: "tool_end", name: "ReadFile", success: true },
      { type: "stats", sessionId: "session-1" }
    ]);
    const store = new MemorySessionStore();
    const service = new AssistantService(gemini, store, {
      systemInstruction: "Be useful."
    });
    const onEvent = vi.fn();

    const response = await service.respondToText({
      chatId: "chat-1",
      userId: "user-1",
      text: "hello",
      onEvent
    });

    expect(response).toBe("Done");
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, { type: "tool_start", name: "ReadFile" });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: "tool_end", name: "ReadFile", success: true });
  });

  it("can disable Gemini CLI session resume for fragile headless sessions", async () => {
    const gemini = new ContextCaptureGeminiClient([{ type: "content_final", text: "Fresh" }, { type: "stats", sessionId: "new-session" }]);
    const store = new MemorySessionStore();
    await store.saveSession({
      chatId: "chat-1",
      userId: "user-1",
      geminiSessionId: "stale-session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const service = new AssistantService(gemini, store, {
      systemInstruction: "Be useful.",
      resumeSessions: false
    });

    await expect(
      service.respondToText({
        chatId: "chat-1",
        userId: "user-1",
        text: "hello"
      })
    ).resolves.toBe("Fresh");

    expect(gemini.lastContext.sessionId).toBeUndefined();
    expect(await store.getSession("chat-1")).toMatchObject({
      chatId: "chat-1",
      userId: "user-1"
    });
    expect((await store.getSession("chat-1"))?.geminiSessionId).toBeUndefined();
  });

  it("loads the Google Workspace extension only for Workspace-style requests", async () => {
    const gemini = new ContextCaptureGeminiClient([{ type: "content_final", text: "Done" }]);
    const service = new AssistantService(gemini, new MemorySessionStore(), {
      systemInstruction: "Be useful."
    });

    await service.respondToText({
      chatId: "chat-1",
      userId: "user-1",
      text: "check my Gmail health"
    });

    expect(gemini.lastContext.extensions).toEqual(["google-workspace-cli"]);

    await service.respondToText({
      chatId: "chat-2",
      userId: "user-1",
      text: "say ready"
    });

    expect(gemini.lastContext.extensions).toBeUndefined();
  });
});

class FakeGeminiClient implements GeminiClient {
  lastInput = "";

  constructor(private readonly events: AssistantEvent[]) {}

  async *sendMessage(input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    this.lastInput = input;
    yield* this.events;
  }
}

class ContextCaptureGeminiClient implements GeminiClient {
  lastContext: GeminiClientContext = { chatId: "", userId: "" };

  constructor(private readonly events: AssistantEvent[]) {}

  async *sendMessage(_input: string, context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    this.lastContext = context;
    yield* this.events;
  }
}

class DeferredGeminiClient implements GeminiClient {
  private resolveEvents!: (events: AssistantEvent[]) => void;
  private readonly eventsPromise = new Promise<AssistantEvent[]>((resolve) => {
    this.resolveEvents = resolve;
  });

  resolve(events: AssistantEvent[]): void {
    this.resolveEvents(events);
  }

  async *sendMessage(_input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    yield* await this.eventsPromise;
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
