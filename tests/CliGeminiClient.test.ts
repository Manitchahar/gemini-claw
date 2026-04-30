import { describe, expect, it } from "vitest";

import {
  buildGeminiCliArgs,
  parseGeminiJsonOutput,
  parseGeminiStreamJsonOutput
} from "../src/gemini/CliGeminiClient.js";
import { GeminiCliError } from "../src/utils/errors.js";

describe("CliGeminiClient parsers", () => {
  it("builds resume args for persisted Gemini sessions", () => {
    expect(
      buildGeminiCliArgs("hello", {
        outputFormat: "json",
        model: "gemini-test",
        sessionId: "session-1"
      })
    ).toEqual(["--prompt", "hello", "--output-format", "json", "--model", "gemini-test", "--resume", "session-1"]);
  });

  it("parses simple JSON responses", () => {
    const events = parseGeminiJsonOutput(JSON.stringify({ response: "Hello there", sessionId: "session-1" }));

    expect(events).toContainEqual({ type: "content_final", text: "Hello there" });
    expect(events).toContainEqual({ type: "stats", sessionId: "session-1", raw: { response: "Hello there", sessionId: "session-1" } });
  });

  it("ignores Gemini CLI stdout diagnostics before JSON responses", () => {
    const events = parseGeminiJsonOutput(
      `MCP issues detected. Run /mcp list for status.${JSON.stringify({ response: "Still JSON", session_id: "session-1" })}`
    );

    expect(events).toContainEqual({ type: "content_final", text: "Still JSON" });
    expect(events).toContainEqual({
      type: "stats",
      sessionId: "session-1",
      raw: { response: "Still JSON", session_id: "session-1" }
    });
  });

  it("uses the final JSON payload when stdout includes earlier JSON diagnostics", () => {
    const events = parseGeminiJsonOutput(
      `${JSON.stringify({ role: "user", text: "do not echo" })}${JSON.stringify({
        response: "Actual answer",
        session_id: "session-1"
      })}`
    );

    expect(events).toContainEqual({ type: "content_final", text: "Actual answer" });
  });

  it("parses nested JSON responses", () => {
    const events = parseGeminiJsonOutput(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: "Nested response" }]
            }
          }
        ]
      })
    );

    expect(events[0]).toEqual({ type: "content_final", text: "Nested response" });
  });

  it("throws on structured JSON errors", () => {
    expect(() => parseGeminiJsonOutput(JSON.stringify({ error: { message: "no auth" } }))).toThrow(GeminiCliError);
  });

  it("parses stream-json assistant message events", () => {
    const output = [
      JSON.stringify({ type: "message", role: "user", text: "ignore me" }),
      JSON.stringify({ type: "message", role: "assistant", text: "Hello " }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "there" } }),
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "content_delta", text: "Hello " },
      { type: "content_delta", text: "there" },
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });

  it("keeps final stream-json events final", () => {
    expect(parseGeminiStreamJsonOutput(JSON.stringify({ type: "content_final", text: "Finished" }))).toEqual([
      { type: "content_final", text: "Finished" }
    ]);
  });

  it("buffers pretty-printed stream JSON objects", () => {
    const output = JSON.stringify({ type: "message", role: "assistant", text: "Pretty" }, null, 2);

    expect(parseGeminiStreamJsonOutput(output)).toEqual([{ type: "content_delta", text: "Pretty" }]);
  });

  it("ignores Gemini CLI stdout diagnostics before stream-json events", () => {
    const output = [
      `MCP issues detected. Run /mcp list for status.${JSON.stringify({ type: "message", role: "assistant", text: "Hello" })}`,
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "content_delta", text: "Hello" },
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });

  it("throws on stream-json error events", () => {
    expect(() => parseGeminiStreamJsonOutput(JSON.stringify({ type: "error", error: { message: "boom" } }))).toThrow(
      GeminiCliError
    );
  });

  it("does not fall back to echoing user stream messages", () => {
    expect(parseGeminiStreamJsonOutput(JSON.stringify({ type: "message", role: "user", text: "do not echo" }))).toEqual([]);
  });

  it("does not fall back to echoing bare non-assistant stream records", () => {
    const output = [
      JSON.stringify({ role: "user", text: "do not echo" }),
      JSON.stringify({ type: "result", session_id: "session-2", status: "success" })
    ].join("\n");

    expect(parseGeminiStreamJsonOutput(output)).toEqual([
      { type: "stats", sessionId: "session-2", raw: { type: "result", session_id: "session-2", status: "success" } }
    ]);
  });
});
