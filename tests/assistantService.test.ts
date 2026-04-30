import { describe, expect, it } from "vitest";

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
});

class FakeGeminiClient implements GeminiClient {
  lastInput = "";

  constructor(private readonly events: AssistantEvent[]) {}

  async *sendMessage(input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    this.lastInput = input;
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
