import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { createToolProgressReporter } from "../src/bot/toolProgress.js";

describe("createToolProgressReporter", () => {
  it("replies for tool starts and edits the same message when the tool finishes", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({ message_id: 99 });
    const reporter = createToolProgressReporter(
      {
        chat: { id: 123 },
        api: { editMessageText },
        reply
      } as unknown as Context,
      60_000
    );

    await reporter({ type: "tool_start", name: "Read_File" });
    await reporter({ type: "tool_end", name: "Read_File", success: true });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("Tool Read File started.");
    expect(editMessageText).toHaveBeenCalledWith(123, 99, "Done: Read File finished.");
    nowSpy.mockRestore();
  });

  it("suppresses duplicate tool updates and ignores non-tool events", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({ message_id: 99 });
    const reporter = createToolProgressReporter(
      {
        chat: { id: 123 },
        api: { editMessageText },
        reply
      } as unknown as Context,
      60_000
    );

    await reporter({ type: "content_final", text: "done" });
    await reporter({ type: "tool_start", name: "RunSubAgent" });
    await reporter({ type: "tool_start", name: "RunSubAgent" });
    await reporter({ type: "tool_end", name: "RunSubAgent", success: false });
    await reporter({ type: "tool_end", name: "RunSubAgent", success: false });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("Tool RunSubAgent started.");
    expect(editMessageText).toHaveBeenCalledWith(123, 99, "Warning: RunSubAgent failed.");
    nowSpy.mockRestore();
  });
});
