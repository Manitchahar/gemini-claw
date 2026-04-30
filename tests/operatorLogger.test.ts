import { describe, expect, it } from "vitest";

import { createOperatorLogger } from "../src/utils/operatorLogger.js";

describe("operatorLogger", () => {
  it("prints a pretty startup banner", () => {
    const lines: string[] = [];
    const logger = createOperatorLogger({
      level: "info",
      style: "pretty",
      includeContent: false,
      previewChars: 120,
      write: (line) => lines.push(line)
    });

    logger.banner({
      bot: "@RockyOperator_bot",
      mode: "YOLO",
      workers: "0/3",
      model: "gemini-default",
      sessions: "isolated",
      extensions: "2"
    });

    expect(lines.join("\n")).toContain("Gemini Claw online");
    expect(lines.join("\n")).toContain("@RockyOperator_bot");
    expect(lines.join("\n")).toContain("YOLO");
    expect(lines.join("\n")).toContain("0/3");
  });

  it("writes parseable JSON events", () => {
    const lines: string[] = [];
    const logger = createOperatorLogger({
      level: "debug",
      style: "json",
      includeContent: false,
      previewChars: 120,
      write: (line) => lines.push(line)
    });

    logger.info("task_queued", { id: "t-0001", chat: "123" });
    logger.debug("gemini_start", { output: "stream-json" });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "info", event: "task_queued", id: "t-0001" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ level: "debug", event: "gemini_start", output: "stream-json" });
  });

  it("truncates previews unless full content logging is enabled", () => {
    const safeLogger = createOperatorLogger({
      level: "info",
      style: "plain",
      includeContent: false,
      previewChars: 12,
      write: () => undefined
    });
    const fullLogger = createOperatorLogger({
      level: "info",
      style: "plain",
      includeContent: true,
      previewChars: 12,
      write: () => undefined
    });

    expect(safeLogger.preview("hello\nthere this is long")).toBe("hello there…");
    expect(fullLogger.preview("hello\nthere this is long")).toBe("hello there this is long");
  });

  it("suppresses operator events when silent", () => {
    const lines: string[] = [];
    const logger = createOperatorLogger({
      level: "silent",
      style: "plain",
      includeContent: false,
      previewChars: 120,
      write: (line) => lines.push(line)
    });

    logger.banner({ bot: "@bot" });
    logger.info("chat_request", { chat: "1" });
    logger.error("chat_error", { chat: "1" });

    expect(lines).toEqual([]);
  });
});
