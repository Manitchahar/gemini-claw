import type { AssistantEvent } from "../assistant/types.js";
import type { GeminiClient, GeminiClientContext } from "./GeminiClient.js";

export class SdkGeminiClient implements GeminiClient {
  async *sendMessage(_input: string, _context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    throw new Error("First-party @google/gemini-cli-sdk integration is not implemented because the package is not published for this app yet.");
  }
}
