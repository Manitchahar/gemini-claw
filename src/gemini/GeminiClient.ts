import type { AssistantEvent } from "../assistant/types.js";

export interface GeminiClientContext {
  chatId: string;
  userId: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface GeminiClient {
  sendMessage(input: string, context: GeminiClientContext): AsyncIterable<AssistantEvent>;
  resetSession?(chatId: string): Promise<void>;
  runCliCommand?(args: string[], context?: { chatId?: string; userId?: string }): Promise<string>;
}
