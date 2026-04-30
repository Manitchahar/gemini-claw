import type { Context } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantService } from "../src/assistant/assistantService.js";
import { createTextMessageHandler } from "../src/bot/messageHandler.js";

describe("createTextMessageHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes Telegram typing status while waiting for Gemini", async () => {
    vi.useFakeTimers();

    let resolveResponse!: (response: string) => void;
    const responsePromise = new Promise<string>((resolve) => {
      resolveResponse = resolve;
    });
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: async () => responsePromise
    };
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      typingActionIntervalMs: 1000
    });

    const handlerPromise = handler(
      createContext({
        text: "hello",
        sendChatAction,
        reply
      })
    );

    await vi.waitFor(() => {
      expect(sendChatAction).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(sendChatAction).toHaveBeenCalledTimes(3);

    resolveResponse("Done");
    await handlerPromise;
    expect(reply).toHaveBeenCalledWith("Done");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
  });

  it("still responds when Telegram rejects the typing status update", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: async () => "Done"
    };
    const sendChatAction = vi.fn().mockRejectedValueOnce(new Error("telegram unavailable"));
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      typingActionIntervalMs: 1000
    });

    await handler(
      createContext({
        text: "hello",
        sendChatAction,
        reply
      })
    );

    expect(reply).toHaveBeenCalledWith("Done");
    expect(consoleError).toHaveBeenCalledWith("Error: telegram unavailable");
  });

  it("starts Gemini response generation without waiting for Telegram typing status", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Done")
    };
    const sendChatAction = vi.fn().mockReturnValue(new Promise<void>(() => undefined));
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      typingActionIntervalMs: 1000
    });

    await handler(
      createContext({
        text: "hello",
        sendChatAction,
        reply
      })
    );

    expect(assistant.respondToText).toHaveBeenCalledWith({
      chatId: "123",
      userId: "456",
      text: "hello",
      onEvent: expect.any(Function)
    });
    expect(reply).toHaveBeenCalledWith("Done");
  });

  it("sends concise tool progress replies before the final response", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn(async (request) => {
        await request.onEvent?.({ type: "tool_start", name: "ReadFile" });
        await request.onEvent?.({ type: "tool_start", name: "ReadFile" });
        await request.onEvent?.({ type: "tool_end", name: "ReadFile", success: true });
        return "Done";
      })
    };
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      typingActionIntervalMs: 1000,
      toolProgressIntervalMs: 0
    });

    await handler(
      createContext({
        text: "hello",
        sendChatAction,
        reply
      })
    );

    expect(reply).toHaveBeenNthCalledWith(1, "🔧 ReadFile started.");
    expect(reply).toHaveBeenNthCalledWith(2, "✅ ReadFile finished.");
    expect(reply).toHaveBeenNthCalledWith(3, "Done");
  });
});

interface CreateContextOptions {
  text: string;
  sendChatAction: (chatId: number, action: "typing") => Promise<void>;
  reply: (text: string) => Promise<void>;
}

function createContext(options: CreateContextOptions): Context {
  return {
    message: { text: options.text },
    chat: { id: 123, type: "private" },
    from: { id: 456 },
    api: {
      sendChatAction: options.sendChatAction
    },
    reply: options.reply
  } as unknown as Context;
}
