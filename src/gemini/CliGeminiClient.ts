import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { AssistantEvent } from "../assistant/types.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import { GeminiCliError } from "../utils/errors.js";
import type { GeminiClient, GeminiClientContext } from "./GeminiClient.js";

const MANAGEMENT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_NODE_COMPILE_CACHE_DIR = join(process.cwd(), ".data", "node-compile-cache");

export interface CliGeminiClientOptions {
  command: string;
  outputFormat: "json" | "stream-json";
  timeoutMs: number;
  model?: string;
  yolo?: boolean;
  approvalMode?: string;
  sandbox?: boolean;
  debug?: boolean;
  trustWorkspace?: boolean;
  cwd?: string;
  allowedTools?: string[];
  allowedMcpServerNames?: string[];
  extensions?: string[];
  includeDirectories?: string[];
  settings?: string;
  logger?: OperatorLogger;
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
    const runOptions = {
      ...this.options,
      model: context.model ?? this.options.model,
      sessionId: context.sessionId,
      extensions: mergeUniqueStringLists(this.options.extensions, context.extensions),
      includeDirectories: mergeUniqueStringLists(this.options.includeDirectories, context.includeDirectories),
      signal: context.signal,
      chatId: context.chatId,
      userId: context.userId
    };

    if (this.options.outputFormat === "stream-json") {
      yield* streamGeminiCliEvents(input, runOptions);
      return;
    }

    const output = await runGeminiCli(input, {
      ...runOptions,
      outputFormat: "json"
    });

    const events = parseGeminiJsonOutput(output.stdout);

    for (const event of events) {
      yield event;
    }
  }

  runCliCommand(args: string[], context: { chatId?: string; userId?: string } = {}): Promise<string> {
    return runGeminiCliCommand({
      command: this.options.command,
      args,
      timeoutMs: Math.min(this.options.timeoutMs, MANAGEMENT_COMMAND_TIMEOUT_MS),
      cwd: this.options.cwd,
      logger: this.options.logger,
      trustWorkspace: this.options.trustWorkspace,
      chatId: context.chatId ?? "system",
      userId: context.userId ?? "system"
    });
  }
}

interface RunGeminiCliOptions extends CliGeminiClientOptions {
  sessionId?: string;
  signal?: AbortSignal;
  chatId: string;
  userId: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

interface RunGeminiCliCommandOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  logger?: OperatorLogger;
  trustWorkspace?: boolean;
  chatId: string;
  userId: string;
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

  if (options.approvalMode && !options.yolo) {
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

function mergeUniqueStringLists(base: string[] | undefined, extra: string[] | undefined): string[] | undefined {
  const merged = [...(base ?? []), ...(extra ?? [])].filter(Boolean);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function runGeminiCli(prompt: string, options: RunGeminiCliOptions): Promise<CommandOutput> {
  const args = buildGeminiCliArgs(prompt, options);
  const logger = options.logger ?? noopOperatorLogger;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GeminiCliError("Gemini CLI run was cancelled"));
      return;
    }

    const resolved = resolveSpawnCommand(options.command, args);
    const child = spawn(resolved.command, resolved.args, {
      env: buildChildEnv(options.trustWorkspace),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();

    logger.info("gemini_start", {
      chat: options.chatId,
      user: options.userId,
      output: options.outputFormat,
      session: options.sessionId ? "present" : "new",
      prompt_chars: prompt.length,
      preview: logger.preview(prompt)
    });

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
      logger.info("gemini_error", { chat: options.chatId, status: "cancel_requested" });
      terminateChildProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL");
        finish(() => {
          reject(new GeminiCliError("Gemini CLI run was cancelled", { stderr }));
        });
      }, 5_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (killTimer) clearTimeout(killTimer);
      logger.error("gemini_error", { chat: options.chatId, status: "timeout", timeout_ms: options.timeoutMs });
      terminateChildProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL");
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
        logger.error("gemini_error", { chat: options.chatId, status: "spawn_failed", error: error.message });
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
          logger.info("gemini_done", { chat: options.chatId, status: "cancelled", duration_ms: Date.now() - startedAt });
          reject(new GeminiCliError("Gemini CLI run was cancelled", { exitCode: code, stderr }));
          return;
        }

        if (code !== 0) {
          logger.error("gemini_error", { chat: options.chatId, status: "non_zero_exit", exit_code: code });
          reject(new GeminiCliError("Gemini CLI exited with a non-zero status", { exitCode: code, stderr }));
          return;
        }

        logger.info("gemini_done", {
          chat: options.chatId,
          status: "ok",
          duration_ms: Date.now() - startedAt,
          stdout_chars: stdout.length
        });
        resolve({ stdout, stderr });
      });
    });
  });
}

function runGeminiCliCommand(options: RunGeminiCliCommandOptions): Promise<string> {
  const logger = options.logger ?? noopOperatorLogger;

  return new Promise((resolve, reject) => {
    const resolved = resolveSpawnCommand(options.command, options.args);
    const autoConfirm = shouldAutoConfirmManagementCommand(options.args);
    const child = spawn(resolved.command, resolved.args, {
      env: buildChildEnv(options.trustWorkspace),
      stdio: [autoConfirm ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    if (!child.stdout || !child.stderr) {
      reject(new GeminiCliError("Failed to start Gemini CLI command with piped stdout/stderr"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();

    logger.info("gemini_command_start", {
      chat: options.chatId,
      user: options.userId,
      command: options.args.join(" ")
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      logger.error("gemini_command_error", {
        chat: options.chatId,
        status: "timeout",
        timeout_ms: options.timeoutMs,
        command: options.args.join(" ")
      });
      terminateChildProcess(child, "SIGTERM");
      finish(() => {
        reject(new GeminiCliError(`Gemini CLI command timed out after ${options.timeoutMs}ms`, { stderr }));
      });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (autoConfirm && child.stdin) {
      child.stdin.write("y\n");
      child.stdin.end();
    }
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
        if (code !== 0) {
          reject(new GeminiCliError("Gemini CLI command exited with a non-zero status", { exitCode: code, stderr }));
          return;
        }

        logger.info("gemini_command_done", {
          chat: options.chatId,
          status: "ok",
          duration_ms: Date.now() - startedAt,
          stdout_chars: stdout.length
        });
        resolve(formatCommandOutput(stdout, stderr));
      });
    });
  });
}

async function* streamGeminiCliEvents(prompt: string, options: RunGeminiCliOptions): AsyncIterable<AssistantEvent> {
  const args = buildGeminiCliArgs(prompt, options);
  const logger = options.logger ?? noopOperatorLogger;

  if (options.signal?.aborted) {
    throw new GeminiCliError("Gemini CLI run was cancelled");
  }

  const resolved = resolveSpawnCommand(options.command, args);
  const child = spawn(resolved.command, resolved.args, {
    env: buildChildEnv(options.trustWorkspace),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(options.cwd ? { cwd: options.cwd } : {})
  });

  const queue: AssistantEvent[] = [];
  const waiters: Array<() => void> = [];
  let stdoutBuffer = "";
  let rawStdout = "";
  let stderr = "";
  let sawEvent = false;
  let settled = false;
  let done = false;
  let failure: unknown;
  let timedOut = false;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  const notify = (): void => {
    while (waiters.length > 0) {
      waiters.shift()?.();
    }
  };

  const waitForChange = (): Promise<void> =>
    new Promise((resolve) => {
      waiters.push(resolve);
    });

  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", abort);
    callback();
    notify();
  };

  const fail = (error: unknown): void => {
    finish(() => {
      failure = error;
    });
  };

  const parseAvailableEvents = (): void => {
    const segments = extractJsonSegments(stdoutBuffer);
    if (segments.length === 0) {
      return;
    }

    let consumed = 0;
    for (const segment of segments) {
      consumed = segment.end;
      try {
        const parsed = JSON.parse(segment.json);
        if (!isStreamToolResultEvent(parsed)) {
          throwIfStructuredError(parsed);
        }
        const event = normalizeStreamEvent(parsed);
        if (event) {
          sawEvent = true;
          queue.push(event);
        }
      } catch (error) {
        fail(error);
        return;
      }
    }
    stdoutBuffer = stdoutBuffer.slice(consumed);
    notify();
  };

  const abort = (): void => {
    cancelled = true;
    if (killTimer) clearTimeout(killTimer);
    logger.info("gemini_error", { chat: options.chatId, status: "cancel_requested" });
    terminateChildProcess(child, "SIGTERM");
    killTimer = setTimeout(() => {
      terminateChildProcess(child, "SIGKILL");
      fail(new GeminiCliError("Gemini CLI run was cancelled", { stderr }));
    }, 5_000);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    if (killTimer) clearTimeout(killTimer);
    logger.error("gemini_error", { chat: options.chatId, status: "timeout", timeout_ms: options.timeoutMs });
    terminateChildProcess(child, "SIGTERM");
    killTimer = setTimeout(() => {
      terminateChildProcess(child, "SIGKILL");
      fail(new GeminiCliError(`Gemini CLI timed out after ${options.timeoutMs}ms`, { stderr }));
    }, 5_000);
  }, options.timeoutMs);

  options.signal?.addEventListener("abort", abort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  logger.info("gemini_start", {
    chat: options.chatId,
    user: options.userId,
    output: options.outputFormat,
    session: options.sessionId ? "present" : "new",
    prompt_chars: prompt.length,
    preview: logger.preview(prompt)
  });

  child.stdout.on("data", (chunk: string) => {
    rawStdout += chunk;
    stdoutBuffer += chunk;
    parseAvailableEvents();
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.on("error", (error) => {
    fail(new GeminiCliError(`Failed to start Gemini CLI command "${options.command}": ${error.message}`));
  });

  child.on("close", (code) => {
    parseAvailableEvents();
    finish(() => {
      if (timedOut) {
        failure = new GeminiCliError(`Gemini CLI timed out after ${options.timeoutMs}ms`, { exitCode: code, stderr });
        return;
      }

      if (cancelled) {
        logger.info("gemini_done", { chat: options.chatId, status: "cancelled", duration_ms: Date.now() - startedAt });
        failure = new GeminiCliError("Gemini CLI run was cancelled", { exitCode: code, stderr });
        return;
      }

      if (code !== 0) {
        logger.error("gemini_error", { chat: options.chatId, status: "non_zero_exit", exit_code: code });
        failure = new GeminiCliError("Gemini CLI exited with a non-zero status", { exitCode: code, stderr });
        return;
      }

      if (!sawEvent) {
        const fallbackText = rawStdout.trim();
        if (fallbackText) {
          queue.push({ type: "content_final", text: fallbackText });
        }
      }

      logger.info("gemini_done", {
        chat: options.chatId,
        status: "ok",
        duration_ms: Date.now() - startedAt
      });
      done = true;
    });
  });

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const event = queue.shift();
      if (event) {
        yield event;
      }
    }

    if (failure) {
      throw failure;
    }

    if (!done) {
      await waitForChange();
    }
  }
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
  return extractJsonSegments(value).map((segment) => segment.json);
}

function extractJsonSegments(value: string): Array<{ json: string; end: number }> {
  const jsonValues: Array<{ json: string; end: number }> = [];
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
        jsonValues.push({ json: value.slice(start, index + 1), end: index + 1 });
        start = -1;
      }
    }
  }

  return jsonValues;
}

function summarizeOutput(value: string): string {
  return JSON.stringify(value.trim().slice(0, 200));
}

function buildChildEnv(trustWorkspace: boolean | undefined): NodeJS.ProcessEnv {
  const nodeCompileCache = process.env.NODE_COMPILE_CACHE || DEFAULT_NODE_COMPILE_CACHE_DIR;
  ensureDirectory(nodeCompileCache);

  return {
    ...process.env,
    NODE_COMPILE_CACHE: nodeCompileCache,
    GEMINI_PTY_INFO: "child_process",
    ...(trustWorkspace === false ? {} : { GEMINI_CLI_TRUST_WORKSPACE: "true" })
  };
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shouldAutoConfirmManagementCommand(args: readonly string[]): boolean {
  if (args[0] !== "skills") {
    return false;
  }

  return ["link", "install", "uninstall", "enable", "disable"].includes(args[1] ?? "");
}

function terminateChildProcess(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    }).on("error", () => undefined);
    return;
  }

  child.kill(signal);
}

function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.cmd$/i.test(command)) {
    return { command, args };
  }

  if (basename(command).toLowerCase() === "gemini.cmd") {
    const bundledGemini = join(dirname(command), "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
    if (existsSync(bundledGemini)) {
      return {
        command: process.execPath,
        args: [bundledGemini, ...args]
      };
    }
  }

  return { command, args };
}
