import type { Context } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantService } from "../src/assistant/assistantService.js";
import { createTextMessageHandler, createUnsupportedMessageHandler } from "../src/bot/messageHandler.js";

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

  it("updates one concise tool progress message before the final response", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn(async (request) => {
        await request.onEvent?.({ type: "tool_start", name: "ReadFile" });
        await request.onEvent?.({ type: "tool_start", name: "ReadFile" });
        await request.onEvent?.({ type: "tool_end", name: "ReadFile", success: true });
        return "Done";
      })
    };
    const sendChatAction = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const reply = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 99 })
      .mockResolvedValueOnce(undefined);
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
        editMessageText,
        reply
      })
    );

    expect(reply).toHaveBeenNthCalledWith(1, "Tool ReadFile started.");
    expect(editMessageText).toHaveBeenCalledWith(123, 99, "Done: ReadFile finished.");
    expect(reply).toHaveBeenNthCalledWith(2, "Done");
  });

  it("uses the fast Gmail health check only for explicit Gmail health requests", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Assistant response")
    };
    const gmailHealthCheck = vi.fn().mockResolvedValue("GMAIL_OK: Gmail profile read succeeded.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      gmailHealthCheck
    });

    await handler(
      createContext({
        text: "Gmail health check only",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(gmailHealthCheck).toHaveBeenCalledTimes(1);
    expect(assistant.respondToText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("GMAIL_OK: Gmail profile read succeeded.");
  });

  it("does not intercept real Gmail search requests as health checks", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Found mail")
    };
    const gmailHealthCheck = vi.fn().mockResolvedValue("GMAIL_OK");
    const gmailRecentSearch = vi.fn().mockResolvedValue("Recent Gmail messages:");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      gmailHealthCheck,
      gmailRecentSearch
    });

    await handler(
      createContext({
        text: "check my Gmail inbox for recent mails",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(gmailHealthCheck).not.toHaveBeenCalled();
    expect(gmailRecentSearch).toHaveBeenCalledWith("check my Gmail inbox for recent mails");
    expect(assistant.respondToText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Recent Gmail messages:");
  });

  it("does not intercept mutating Gmail requests as recent searches", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Drafted")
    };
    const gmailRecentSearch = vi.fn().mockResolvedValue("Recent Gmail messages:");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      gmailRecentSearch
    });

    await handler(
      createContext({
        text: "reply to my latest Gmail",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(gmailRecentSearch).not.toHaveBeenCalled();
    expect(assistant.respondToText).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Drafted");
  });

  it("answers sent-mail count requests through the Gmail count fast path", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Assistant response")
    };
    const gmailSentCount = vi.fn().mockResolvedValue("GMAIL_SENT_COUNT: 8 sent messages yesterday.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      gmailSentCount
    });

    await handler(
      createContext({
        text: "how many mails i set yesterdya",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(gmailSentCount).toHaveBeenCalledWith("how many mails i set yesterdya");
    expect(assistant.respondToText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("GMAIL_SENT_COUNT: 8 sent messages yesterday.");
  });

  it("answers read-only calendar agenda requests through the calendar fast path", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Assistant response")
    };
    const calendarAgenda = vi.fn().mockResolvedValue("Calendar agenda today: 1 event.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      calendarAgenda
    });

    await handler(
      createContext({
        text: "show my calendar today privacy-safe",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(calendarAgenda).toHaveBeenCalledWith("show my calendar today privacy-safe");
    expect(assistant.respondToText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Calendar agenda today: 1 event.");
  });

  it("does not intercept mutating calendar requests", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Scheduled")
    };
    const calendarAgenda = vi.fn().mockResolvedValue("Calendar agenda today: 1 event.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      calendarAgenda
    });

    await handler(
      createContext({
        text: "schedule a meeting on my calendar today",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(calendarAgenda).not.toHaveBeenCalled();
    expect(assistant.respondToText).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Scheduled");
  });

  it("answers read-only Drive recent file requests through the Drive fast path", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Assistant response")
    };
    const driveRecentFiles = vi.fn().mockResolvedValue("Recent Drive files: 3 shown.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      driveRecentFiles
    });

    await handler(
      createContext({
        text: "show recent drive files privacy-safe",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(driveRecentFiles).toHaveBeenCalledWith("show recent drive files privacy-safe");
    expect(assistant.respondToText).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Recent Drive files: 3 shown.");
  });

  it("does not intercept mutating Drive requests", async () => {
    const assistant: Pick<AssistantService, "respondToText"> = {
      respondToText: vi.fn().mockResolvedValue("Shared")
    };
    const driveRecentFiles = vi.fn().mockResolvedValue("Recent Drive files: 3 shown.");
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createTextMessageHandler({
      assistant,
      responseChunkSize: 3900,
      driveRecentFiles
    });

    await handler(
      createContext({
        text: "share my latest drive file",
        sendChatAction: vi.fn().mockResolvedValue(undefined),
        reply
      })
    );

    expect(driveRecentFiles).not.toHaveBeenCalled();
    expect(assistant.respondToText).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("Shared");
  });
});

describe("createUnsupportedMessageHandler", () => {
  it.each([
    ["photo", { photo: [{}] }, "Photo input is not supported yet."],
    ["photo with caption", { photo: [{}], caption: "what is this?" }, "Photo with caption input is not supported yet."],
    ["voice", { voice: {} }, "Voice message input is not supported yet."],
    ["audio", { audio: {} }, "Audio input is not supported yet."],
    ["video", { video: {} }, "Video input is not supported yet."],
    ["document", { document: {} }, "Document input is not supported yet."],
    ["sticker", { sticker: {} }, "Sticker input is not supported yet."],
    ["location", { location: {} }, "Location input is not supported yet."]
  ])("explains unsupported %s messages", async (_name, message, expected) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const handler = createUnsupportedMessageHandler();

    await handler({
      message,
      chat: { id: 123, type: "private" },
      from: { id: 456 },
      reply
    } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("send text prompts only"));
  });
});

interface CreateContextOptions {
  text: string;
  sendChatAction: (chatId: number, action: "typing") => Promise<void>;
  editMessageText?: (chatId: number, messageId: number, text: string) => Promise<void>;
  reply: (text: string) => Promise<void>;
}

function createContext(options: CreateContextOptions): Context {
  return {
    message: { text: options.text },
    chat: { id: 123, type: "private" },
    from: { id: 456 },
    api: {
      sendChatAction: options.sendChatAction,
      editMessageText: options.editMessageText ?? vi.fn().mockResolvedValue(undefined)
    },
    reply: options.reply
  } as unknown as Context;
}
