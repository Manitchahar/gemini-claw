export interface AssistantRequest {
  chatId: string;
  userId: string;
  text: string;
}

export type AssistantEvent =
  | {
      type: "content_delta";
      text: string;
    }
  | {
      type: "content_final";
      text: string;
    }
  | {
      type: "tool_start";
      name: string;
    }
  | {
      type: "tool_end";
      name: string;
      success: boolean;
    }
  | {
      type: "stats";
      sessionId?: string;
      raw?: unknown;
    };

export interface AssistantOptions {
  systemInstruction: string;
}
