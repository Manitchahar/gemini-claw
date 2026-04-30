import { spawn } from "node:child_process";

import type { AssistantEvent } from "../assistant/types.js";
import { GeminiCliError } from "../utils/errors.js";
import type { GeminiClient, GeminiClientContext } from "./GeminiClient.js";

export interface CliGeminiClientOptions {
  command: string;
  outputFormat: "json" | "stream-json";
  timeoutMs: number;
  model?: string;
  yolo?: boolean;
  approvalMode?: string;
  sandbox?: boolean;
  debug?: boolean;
  cwd?: string;
  allowedTools?: string[];
  allowedMcpServerNames?: string[];
  extensions?: string[];
  includeDirectories?: string[];
  settings?: string;
}

export interface GeminiCliArgsOptions {
  outputFormat: "json" | "stream-json";
  model?: string;
  sessionId?: string;
  yolo?: boolean;
  approvalMode?: string;
  sandbox?: boolean;
  debug?: boolean;
  allowedTools?: string[];
  allowedMcpServerNames?: string[];
  extensions?: string[];
  includeDirectories?: string[];
  settings?: string;
}

export class CliGeminiClient implements GeminiClient {
  constructor(private readonly options: CliGeminiClientOptions) {}

  async *sendMessage(input: string, context: GeminiClientContext): AsyncIterable<AssistantEvent> {
    const output = await runGeminiCli(input, {
      ...this.options,
      model: context.model ?? this.options.model,
      sessionId: context.sessionId,
      signal: context.signal
    });

    const events =
      this.options.outputFormat === "stream-json"
        ? parseGeminiStreamJsonOutput(output.stdout)
        : parseGeminiJsonOutput(output.stdout);

    for (const event of events) {
      yield event;
    }
  }
}

interface RunGeminiCliOptions extends CliGeminiClientOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

export function buildGeminiCliArgs(prompt: string, options: GeminiCliArgsOptions): string[] {
  const args = ["--prompt", prompt, "--output-format", options.outputFormat];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  if (options.yolo) {
    args.push("--yolo");
  }

  if (options.approvalMode) {
    args.push("--approval-mode", options.approvalMode);
  }

  if (options.sandbox) {
    args.push("--sandbox");
  }

  if (options.debug) {
    args.push("--debug");
  }

  appendCommaListArg(args, "--allowed-tools", options.allowedTools);
  appendCommaListArg(args, "--allowed-mcp-server-names", options.allowedMcpServerNames);
  appendCommaListArg(args, "--extensions", options.extensions);
  appendCommaListArg(args, "--include-directories", options.includeDirectories);

  if (options.settings) {
    args.push("--settings", options.settings);
  }

  return args;
}

function appendCommaListArg(args: string[], flag: string, values: string[] | undefined): void {
  if (values && values.length > 0) {
    args.push(flag, values.join(","));
  }
}

function runGeminiCli(prompt: string, options: RunGeminiCliOptions): Promise<CommandOutput> {
  const args = buildGeminiCliArgs(prompt, options);

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GeminiCliError("Gemini CLI run was cancelled"));
      return;
    }

    const child = spawn(options.command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };

    const abort = (): void => {
      cancelled = true;
      if (killTimer) clearTimeout(killTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => {
          reject(new GeminiCliError("Gemini CLI run was cancelled", { stderr }));
        });
      }, 5_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (killTimer) clearTimeout(killTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => {
          reject(new GeminiCliError(`Gemini CLI timed out after ${options.timeoutMs}ms`, { stderr }));
        });
      }, 5_000);
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish(() => {
        reject(new GeminiCliError(`Failed to start Gemini CLI command "${options.command}": ${error.message}`));
      });
    });

    child.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new GeminiCliError(`Gemini CLI timed out after ${options.timeoutMs}ms`, { exitCode: code, stderr }));
          return;
        }

        if (cancelled) {
          reject(new GeminiCliError("Gemini CLI run was cancelled", { exitCode: code, stderr }));
          return;
        }

        if (code !== 0) {
          reject(new GeminiCliError("Gemini CLI exited with a non-zero status", { exitCode: code, stderr }));
          return;
        }

        resolve({ stdout, stderr });
      });
    });
  });
}

export function parseGeminiJsonOutput(stdout: string): AssistantEvent[] {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return [{ type: "content_final", text: "" }];
  }

  const parsed = parseJson(trimmed);
  throwIfStructuredError(parsed);
  const text = extractText(parsed).trim();
  const events: AssistantEvent[] = [];

  if (text) {
    events.push({ type: "content_final", text });
  }

  const sessionId = extractStringProperty(parsed, ["sessionId", "session_id", "conversationId", "conversation_id"]);
  events.push({ type: "stats", sessionId, raw: parsed });

  return events;
}

export function parseGeminiStreamJsonOutput(stdout: string): AssistantEvent[] {
  const events: AssistantEvent[] = [];
  const parsedEvents = parseJsonSequence(stdout);

  for (const parsed of parsedEvents) {
    if (!isStreamToolResultEvent(parsed)) {
      throwIfStructuredError(parsed);
    }

    const event = normalizeStreamEvent(parsed);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

function parseJson(value: string): unknown {
  const jsonValues = extractJsonValues(value);

  if (jsonValues.length === 0) {
    throw new GeminiCliError(`Gemini CLI returned invalid JSON: no JSON object found in output: ${summarizeOutput(value)}`);
  }

  let lastError: unknown;
  let parsed: unknown;
  for (const json of jsonValues) {
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      lastError = error;
    }
  }

  if (parsed !== undefined) {
    return parsed;
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new GeminiCliError(`Gemini CLI returned invalid JSON: ${message}`);
}

function parseJsonSequence(stdout: string): unknown[] {
  const parsed: unknown[] = [];
  let lastError: unknown;

  for (const json of extractJsonValues(stdout)) {
    try {
      parsed.push(JSON.parse(json));
    } catch (error) {
      lastError = error;
    }
  }

  if (parsed.length === 0 && stdout.trim()) {
    const message = lastError instanceof Error ? lastError.message : "no JSON object found";
    throw new GeminiCliError(`Gemini CLI returned invalid JSON: ${message}`);
  }

  return parsed;
}

function normalizeStreamEvent(event: unknown): AssistantEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const type = typeof event.type === "string" ? event.type : "";
  const role = extractRole(event);
  const text = extractText(event);

  switch (type) {
    case "init":
    case "result":
      return normalizeStreamStatsEvent(event);
    case "message":
      return role === "assistant" && text ? { type: "content_delta", text } : undefined;
    case "tool_use":
      return normalizeStreamToolUseEvent(event);
    case "tool_result":
      return normalizeStreamToolResultEvent(event);
    case "error":
      throwStructuredError(event);
  }

  if (role && role !== "assistant") {
    return undefined;
  }

  if (type === "content_final" && text) {
    return { type: "content_final", text };
  }

  if (type === "content_delta" && text) {
    return { type: "content_delta", text };
  }

  if (text && /final|result|response/i.test(type)) {
    return { type: "content_final", text };
  }

  if (text && /delta|content|text/i.test(type)) {
    return { type: "content_delta", text };
  }

  const toolName = extractStringProperty(event, ["toolName", "tool_name", "name"]);
  if (toolName && (type === "tool_use" || /tool.*start|function.*call/i.test(type))) {
    return { type: "tool_start", name: toolName };
  }

  if (toolName && (type === "tool_result" || /tool.*end|tool.*finish|function.*response/i.test(type))) {
    return { type: "tool_end", name: toolName, success: !extractErrorMessage(event) };
  }

  const sessionId = extractStringProperty(event, ["sessionId", "session_id", "conversationId", "conversation_id"]);
  if (sessionId || /stats|metadata/i.test(type)) {
    return { type: "stats", sessionId, raw: event };
  }

  if (text) {
    return { type: "content_delta", text };
  }

  return undefined;
}

function isStreamToolResultEvent(event: unknown): boolean {
  return isRecord(event) && event.type === "tool_result";
}

function normalizeStreamStatsEvent(event: Record<string, unknown>): AssistantEvent {
  const sessionId = extractSessionId(event);
  return { type: "stats", sessionId, raw: event };
}

function normalizeStreamToolUseEvent(event: Record<string, unknown>): AssistantEvent | undefined {
  const toolName = extractToolName(event);
  return toolName
    ? { type: "tool_start", name: toolName, raw: event, possibleSubagentName: extractPossibleSubagentName(event) }
    : undefined;
}

function normalizeStreamToolResultEvent(event: Record<string, unknown>): AssistantEvent | undefined {
  const toolName = extractToolName(event);
  return toolName
    ? {
        type: "tool_end",
        name: toolName,
        success: !extractErrorMessage(event),
        raw: event,
        possibleSubagentName: extractPossibleSubagentName(event)
      }
    : undefined;
}

function throwIfStructuredError(value: unknown): void {
  const message = extractErrorMessage(value);
  if (message) {
    throw new GeminiCliError(formatStructuredErrorMessage(message));
  }
}

function throwStructuredError(value: unknown): never {
  const message = extractErrorMessage(value) || "Unknown Gemini CLI error";
  throw new GeminiCliError(formatStructuredErrorMessage(message));
}

function formatStructuredErrorMessage(message: string): string {
  return `Gemini CLI returned an error: ${message}`;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "error") {
    const nested = extractErrorMessage(value.error);
    return nested || extractText(value) || "Unknown Gemini CLI error";
  }

  const error = value.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (isRecord(error)) {
    return extractText(error) || extractStringProperty(error, ["message", "detail", "description"]);
  }

  return undefined;
}

function extractRole(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const directRole = value.role;
  if (typeof directRole === "string") {
    return directRole;
  }

  for (const key of ["message", "content", "event"]) {
    const nested = value[key];
    if (isRecord(nested) && typeof nested.role === "string") {
      return nested.role;
    }
  }

  return undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter((item) => item.length > 0)
      .join("\n")
      .trimEnd();
  }

  if (!isRecord(value)) {
    return "";
  }

  for (const key of ["response", "text", "output", "content", "message", "result", "answer"]) {
    if (key in value) {
      const text = extractText(value[key]);
      if (text.trim()) return text;
    }
  }

  if ("parts" in value) {
    const text = extractText(value.parts);
    if (text.trim()) return text;
  }

  if ("candidates" in value) {
    const text = extractText(value.candidates);
    if (text.trim()) return text;
  }

  return "";
}

function extractStringProperty(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const property = value[key];
    if (typeof property === "string" && property.trim()) {
      return property.trim();
    }
  }

  return undefined;
}

function extractSessionId(value: unknown): string | undefined {
  return extractStringProperty(value, ["sessionId", "session_id", "conversationId", "conversation_id"]);
}

function extractToolName(value: unknown): string | undefined {
  return extractStringProperty(value, ["name", "toolName", "tool_name"]);
}

function extractPossibleSubagentName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const explicit = extractStringProperty(value, ["subagent", "subAgent", "sub_agent", "agent", "agentName", "agent_name"]);
  if (explicit) {
    return explicit;
  }

  const toolName = extractToolName(value);
  if (toolName && /(?:^|[_\-\s])(?:subagent|sub-agent|agent)(?:$|[_\-\s])/i.test(toolName)) {
    return toolName;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractJsonValues(value: string): string[] {
  const jsonValues: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        jsonValues.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return jsonValues;
}

function summarizeOutput(value: string): string {
  return JSON.stringify(value.trim().slice(0, 200));
}
