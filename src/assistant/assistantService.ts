import type { GeminiClient } from "../gemini/GeminiClient.js";
import { createSessionRecord } from "../storage/SessionStore.js";
import type { SessionRecord, SessionStore } from "../storage/SessionStore.js";
import { buildAssistantPrompt } from "./prompts.js";
import type { AssistantOptions, AssistantRequest } from "./types.js";

export class AssistantService {
  private readonly chatQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly geminiClient: GeminiClient,
    private readonly sessionStore: SessionStore,
    private readonly options: AssistantOptions
  ) {}

  async respondToText(request: AssistantRequest): Promise<string> {
    return this.runForChat(request.chatId, async () => this.respondToTextUnlocked(request));
  }

  async resetChat(chatId: string): Promise<void> {
    await this.runForChat(chatId, async () => {
      await this.geminiClient.resetSession?.(chatId);
      await this.sessionStore.deleteSession(chatId);
    });
  }

  private async respondToTextUnlocked(request: AssistantRequest): Promise<string> {
    const session = await this.getOrCreateSession(request);
    const prompt = buildAssistantPrompt(request.text, this.options.systemInstruction);
    const contentChunks: string[] = [];
    let finalContent = "";
    let nextSessionId = session.geminiSessionId;

    for await (const event of this.geminiClient.sendMessage(prompt, {
      chatId: request.chatId,
      userId: request.userId,
      sessionId: session.geminiSessionId
    })) {
      if (event.type === "tool_start" || event.type === "tool_end") {
        await request.onEvent?.(event);
      }

      if (event.type === "content_delta") {
        contentChunks.push(event.text);
      }

      if (event.type === "content_final") {
        finalContent = event.text;
      }

      if (event.type === "stats" && event.sessionId) {
        nextSessionId = event.sessionId;
      }
    }

    if (nextSessionId !== session.geminiSessionId) {
      await this.sessionStore.saveSession({
        ...session,
        geminiSessionId: nextSessionId
      });
    } else {
      await this.sessionStore.saveSession(session);
    }

    const response = finalContent || contentChunks.join("");
    return response.trim() || "I did not receive a response from Gemini.";
  }

  private async getOrCreateSession(request: AssistantRequest): Promise<SessionRecord> {
    const existing = await this.sessionStore.getSession(request.chatId);

    if (existing) {
      return {
        ...existing,
        userId: request.userId
      };
    }

    const created = createSessionRecord({
      chatId: request.chatId,
      userId: request.userId
    });
    await this.sessionStore.saveSession(created);
    return created;
  }

  private async runForChat<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);

    this.chatQueues.set(chatId, queued);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.chatQueues.get(chatId) === queued) {
        this.chatQueues.delete(chatId);
      }
    }
  }
}
