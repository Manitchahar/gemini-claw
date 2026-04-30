import type { AssistantEvent } from "../assistant/types.js";
import type { GeminiClient, GeminiClientContext } from "./GeminiClient.js";

export class SdkGeminiClient implements GeminiClient {
  async *sendMessage(_input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    throw new Error(
      "First-party Gemini CLI SDK integration is intentionally unavailable and not the default until a stable package is published for this app."
    );
  }
}
