import type { GeminiClient } from "../gemini/GeminiClient.js";
import { createSessionRecord } from "../storage/SessionStore.js";
import type { SessionStore } from "../storage/SessionStore.js";
import { GeminiCliError } from "../utils/errors.js";
import type { ChatOperationRunner } from "./chatQueue.js";
import { buildAssistantPrompt } from "./prompts.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import type {
  AssistantEvent,
  AssistantTaskCallbacks,
  AssistantTaskRequest,
  AssistantTaskStatus,
  AssistantTaskSummary,
  SubagentStatus,
  WorkerStats
} from "./types.js";

export type WorkerSessionMode = "isolated" | "chat";

export interface AssistantTaskManagerOptions {
  systemInstruction: string;
  maxWorkers: number;
  maxChatWorkers: number;
  maxQueuedTasks: number;
  maxChatQueuedTasks: number;
  historyLimit: number;
  workerSessionMode: WorkerSessionMode;
  extensions: readonly string[];
  sharedChatQueue?: ChatOperationRunner;
  logger?: OperatorLogger;
}

interface ManagedTask extends AssistantTaskSummary {
  controller: AbortController;
  callbacks?: AssistantTaskCallbacks;
}

export class AssistantTaskManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly queue: ManagedTask[] = [];
  private readonly running = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly geminiClient: GeminiClient,
    private readonly sessionStore: SessionStore,
    private readonly options: AssistantTaskManagerOptions
  ) {}

  startTask(request: AssistantTaskRequest, callbacks?: AssistantTaskCallbacks): AssistantTaskSummary {
    if (this.queue.length >= this.options.maxQueuedTasks) {
      throw new TaskQueueFullError(`Task queue is full (${this.options.maxQueuedTasks} queued tasks).`);
    }

    if (this.queuedCountForChat(request.chatId) >= this.options.maxChatQueuedTasks) {
      throw new TaskQueueFullError(
        `Task queue for this chat is full (${this.options.maxChatQueuedTasks} queued tasks).`
      );
    }

    const task: ManagedTask = {
      id: this.createTaskId(),
      chatId: request.chatId,
      userId: request.userId,
      text: request.text,
      status: "queued",
      createdAt: new Date().toISOString(),
      tools: [],
      failedTools: [],
      possibleSubagents: [],
      controller: new AbortController(),
      callbacks
    };

    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.logger.info("task_queued", {
      id: task.id,
      chat: task.chatId,
      user: task.userId,
      queued: this.queue.length,
      workers: `${this.running.size}/${this.options.maxWorkers}`,
      chars: task.text.length,
      preview: this.logger.preview(task.text)
    });
    this.trimHistory();
    queueMicrotask(() => this.drainQueue());
    return toSummary(task);
  }

  listTasks(chatId: string): AssistantTaskSummary[] {
    return [...this.tasks.values()]
      .filter((task) => task.chatId === chatId)
      .map(toSummary)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getTask(chatId: string, taskId: string): AssistantTaskSummary | undefined {
    const task = this.tasks.get(taskId);
    return task && task.chatId === chatId ? toSummary(task) : undefined;
  }

  cancelTask(chatId: string, taskId: string): AssistantTaskSummary | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.chatId !== chatId) {
      return undefined;
    }

    if (task.status === "queued") {
      this.removeFromQueue(task.id);
      this.finishTask(task, "cancelled");
      this.logger.info("task_cancelled", { id: task.id, chat: task.chatId, status: "queued" });
      return toSummary(task);
    }

    if (task.status === "running") {
      task.controller.abort();
      return toSummary(task);
    }

    return toSummary(task);
  }

  getWorkerStats(): WorkerStats {
    return {
      maxWorkers: this.options.maxWorkers,
      maxChatWorkers: this.effectiveMaxChatWorkers(),
      maxQueuedTasks: this.options.maxQueuedTasks,
      maxChatQueuedTasks: this.options.maxChatQueuedTasks,
      running: this.running.size,
      queued: this.queue.length,
      runningTaskIds: [...this.running]
    };
  }

  getSubagentStatus(chatId?: string): SubagentStatus {
    const tasks = [...this.tasks.values()].filter((task) => !chatId || task.chatId === chatId);
    return {
      extensionsConfigured: this.options.extensions.length > 0,
      configuredExtensions: [...this.options.extensions],
      observedSubagents: unique(tasks.flatMap((task) => task.possibleSubagents))
    };
  }

  private drainQueue(): void {
    for (const task of [...this.queue]) {
      if (this.running.size >= this.options.maxWorkers) {
        return;
      }

      if (this.runningCountForChat(task.chatId) >= this.effectiveMaxChatWorkers()) {
        continue;
      }

      this.removeFromQueue(task.id);
      void this.runTask(task);
    }
  }

  private async runTask(task: ManagedTask): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    this.running.add(task.id);
    const startedAt = Date.now();

    this.logger.info("task_running", {
      id: task.id,
      chat: task.chatId,
      workers: `${this.running.size}/${this.options.maxWorkers}`,
      queued: this.queue.length,
      session: this.options.workerSessionMode
    });

    const run = async (): Promise<void> => {
      await this.runTaskUnlocked(task);
    };

    try {
      if (this.options.workerSessionMode === "chat" && this.options.sharedChatQueue) {
        await this.options.sharedChatQueue.run(task.chatId, run);
      } else {
        await run();
      }
    } finally {
      this.running.delete(task.id);
      this.logTaskFinished(task, Date.now() - startedAt);
      await notifyTaskComplete(task);
      this.trimHistory();
      this.drainQueue();
    }
  }

  private async runTaskUnlocked(task: ManagedTask): Promise<void> {
    const contentChunks: string[] = [];
    let finalContent = "";
    let nextSessionId: string | undefined;

    try {
      const sessionId = await this.resolveSessionId(task);
      nextSessionId = sessionId;
      const prompt = buildAssistantPrompt(task.text, this.options.systemInstruction);

      for await (const event of this.geminiClient.sendMessage(prompt, {
        chatId: task.chatId,
        userId: task.userId,
        sessionId,
        signal: task.controller.signal
      })) {
        recordTaskEvent(task, event);
        this.logTaskEvent(task, event);
        await notifyTaskEvent(task, event);

        if (event.type === "content_delta") {
          contentChunks.push(event.text);
        }

        if (event.type === "content_final") {
          finalContent = event.text;
        }

        if (event.type === "stats" && event.sessionId) {
          nextSessionId = event.sessionId;
        }
      }

      task.response = (finalContent || contentChunks.join("")).trim() || "I did not receive a response from Gemini.";
      if (this.options.workerSessionMode === "chat" && nextSessionId) {
        await this.saveChatSession(task, nextSessionId);
      }
      this.finishTask(task, "succeeded");
    } catch (error) {
      task.error = formatTaskError(error);
      this.finishTask(task, task.controller.signal.aborted ? "cancelled" : "failed");
    }
  }

  private async resolveSessionId(task: ManagedTask): Promise<string | undefined> {
    if (this.options.workerSessionMode === "isolated") {
      return undefined;
    }

    const existing = await this.sessionStore.getSession(task.chatId);
    if (existing) {
      return existing.geminiSessionId;
    }

    await this.sessionStore.saveSession(
      createSessionRecord({
        chatId: task.chatId,
        userId: task.userId
      })
    );
    return undefined;
  }

  private async saveChatSession(task: ManagedTask, geminiSessionId: string): Promise<void> {
    const existing = await this.sessionStore.getSession(task.chatId);
    await this.sessionStore.saveSession({
      ...(existing ??
        createSessionRecord({
          chatId: task.chatId,
          userId: task.userId
        })),
      userId: task.userId,
      geminiSessionId,
      updatedAt: new Date().toISOString()
    });
  }

  private finishTask(task: ManagedTask, status: AssistantTaskStatus): void {
    task.status = status;
    task.finishedAt = new Date().toISOString();
  }

  private removeFromQueue(taskId: string): void {
    const index = this.queue.findIndex((task) => task.id === taskId);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
  }

  private runningCountForChat(chatId: string): number {
    let count = 0;
    for (const taskId of this.running) {
      if (this.tasks.get(taskId)?.chatId === chatId) {
        count += 1;
      }
    }
    return count;
  }

  private queuedCountForChat(chatId: string): number {
    return this.queue.filter((task) => task.chatId === chatId).length;
  }

  private effectiveMaxChatWorkers(): number {
    return this.options.workerSessionMode === "chat" ? 1 : this.options.maxChatWorkers;
  }

  private trimHistory(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .sort((left, right) => (left.finishedAt ?? left.createdAt).localeCompare(right.finishedAt ?? right.createdAt));

    while (completed.length > this.options.historyLimit) {
      const task = completed.shift();
      if (task) {
        this.tasks.delete(task.id);
      }
    }
  }

  private createTaskId(): string {
    const id = `t-${this.nextId.toString(36).padStart(4, "0")}`;
    this.nextId += 1;
    return id;
  }

  private get logger(): OperatorLogger {
    return this.options.logger ?? noopOperatorLogger;
  }

  private logTaskEvent(task: ManagedTask, event: AssistantEvent): void {
    if (event.type !== "tool_start" && event.type !== "tool_end") return;
    this.logger.info(event.type === "tool_start" ? "tool_start" : "tool_end", {
      id: task.id,
      chat: task.chatId,
      name: event.name,
      success: event.type === "tool_end" ? event.success : undefined
    });
    if (event.possibleSubagentName) {
      this.logger.info("subagent", { id: task.id, chat: task.chatId, name: event.possibleSubagentName });
    }
  }

  private logTaskFinished(task: ManagedTask, durationMs: number): void {
    const event =
      task.status === "succeeded" ? "task_completed" : task.status === "cancelled" ? "task_cancelled" : "task_failed";
    this.logger.info(event, {
      id: task.id,
      chat: task.chatId,
      duration_ms: durationMs,
      chars: task.response?.length,
      tools: task.tools.length,
      subagents: task.possibleSubagents.length > 0 ? task.possibleSubagents : "not_observed",
      error: task.error
    });
  }
}

export class TaskQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskQueueFullError";
  }
}

function recordTaskEvent(task: ManagedTask, event: AssistantEvent): void {
  if (event.type === "tool_start" || event.type === "tool_end") {
    addUnique(task.tools, event.name);
    if (event.type === "tool_end" && !event.success) {
      addUnique(task.failedTools, event.name);
    }
    if (event.possibleSubagentName) {
      addUnique(task.possibleSubagents, event.possibleSubagentName);
    }
  }
}

async function notifyTaskEvent(task: ManagedTask, event: AssistantEvent): Promise<void> {
  try {
    await task.callbacks?.onEvent?.(toSummary(task), event);
  } catch (error) {
    console.error(`Task ${task.id} event callback failed: ${formatTaskError(error)}`);
  }
}

async function notifyTaskComplete(task: ManagedTask): Promise<void> {
  try {
    await task.callbacks?.onComplete?.(toSummary(task));
  } catch (error) {
    console.error(`Task ${task.id} completion callback failed: ${formatTaskError(error)}`);
  }
}

function toSummary(task: ManagedTask): AssistantTaskSummary {
  return {
    id: task.id,
    chatId: task.chatId,
    userId: task.userId,
    text: task.text,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    response: task.response,
    error: task.error,
    tools: [...task.tools],
    failedTools: [...task.failedTools],
    possibleSubagents: [...task.possibleSubagents]
  };
}

function formatTaskError(error: unknown): string {
  if (error instanceof GeminiCliError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
