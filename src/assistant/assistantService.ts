import type { GeminiClient } from "../gemini/GeminiClient.js";
import { createSessionRecord } from "../storage/SessionStore.js";
import type { SessionRecord, SessionStore } from "../storage/SessionStore.js";
import { ChatOperationQueue } from "./chatQueue.js";
import type { ChatOperationRunner } from "./chatQueue.js";
import { buildAssistantPrompt } from "./prompts.js";
import { noopOperatorLogger, type OperatorLogger } from "../utils/operatorLogger.js";
import type { AssistantTaskManager } from "./taskManager.js";
import type {
  AssistantOptions,
  AssistantRequest,
  AssistantTaskCallbacks,
  AssistantTaskRequest,
  AssistantTaskSummary,
  SubagentStatus,
  WorkerStats
} from "./types.js";

export class AssistantService {
  constructor(
    private readonly geminiClient: GeminiClient,
    private readonly sessionStore: SessionStore,
    private readonly options: AssistantOptions,
    private readonly taskManager?: AssistantTaskManager,
    private readonly chatQueue: ChatOperationRunner = new ChatOperationQueue(),
    private readonly logger: OperatorLogger = noopOperatorLogger
  ) {}

  async respondToText(request: AssistantRequest): Promise<string> {
    return this.chatQueue.run(request.chatId, async () => this.respondToTextUnlocked(request));
  }

  async resetChat(chatId: string): Promise<void> {
    await this.chatQueue.run(chatId, async () => {
      this.logger.info("reset", { chat: chatId });
      await this.geminiClient.resetSession?.(chatId);
      await this.sessionStore.deleteSession(chatId);
    });
  }

  startTask(request: AssistantTaskRequest, callbacks?: AssistantTaskCallbacks): AssistantTaskSummary {
    return this.requireTaskManager().startTask(request, callbacks);
  }

  listTasks(chatId: string): AssistantTaskSummary[] {
    return this.requireTaskManager().listTasks(chatId);
  }

  getTask(chatId: string, taskId: string): AssistantTaskSummary | undefined {
    return this.requireTaskManager().getTask(chatId, taskId);
  }

  cancelTask(chatId: string, taskId: string): AssistantTaskSummary | undefined {
    return this.requireTaskManager().cancelTask(chatId, taskId);
  }

  getWorkerStats(): WorkerStats {
    return this.requireTaskManager().getWorkerStats();
  }

  getSubagentStatus(chatId?: string): SubagentStatus {
    return this.requireTaskManager().getSubagentStatus(chatId);
  }

  private async respondToTextUnlocked(request: AssistantRequest): Promise<string> {
    const session = await this.getOrCreateSession(request);
    const prompt = buildAssistantPrompt(request.text, this.options.systemInstruction);
    const contentChunks: string[] = [];
    let finalContent = "";
    let nextSessionId = session.geminiSessionId;
    const startedAt = Date.now();

    this.logger.info("chat_request", {
      chat: request.chatId,
      user: request.userId,
      chars: request.text.length,
      preview: this.logger.preview(request.text)
    });

    for await (const event of this.geminiClient.sendMessage(prompt, {
      chatId: request.chatId,
      userId: request.userId,
      sessionId: session.geminiSessionId
    })) {
      if (event.type === "tool_start" || event.type === "tool_end") {
        this.logger.info(event.type === "tool_start" ? "tool_start" : "tool_end", {
          chat: request.chatId,
          name: event.name,
          success: event.type === "tool_end" ? event.success : undefined
        });
        if (event.possibleSubagentName) {
          this.logger.info("subagent", { chat: request.chatId, name: event.possibleSubagentName });
        }
        await request.onEvent?.(event);
      }

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

    if (nextSessionId !== session.geminiSessionId) {
      await this.sessionStore.saveSession({
        ...session,
        geminiSessionId: nextSessionId
      });
    } else {
      await this.sessionStore.saveSession(session);
    }

    const response = finalContent || contentChunks.join("");
    const trimmed = response.trim() || "I did not receive a response from Gemini.";
    this.logger.info("chat_reply", {
      chat: request.chatId,
      chars: trimmed.length,
      duration_ms: Date.now() - startedAt,
      preview: this.logger.preview(trimmed)
    });
    return trimmed;
  }

  private async getOrCreateSession(request: AssistantRequest): Promise<SessionRecord> {
    const existing = await this.sessionStore.getSession(request.chatId);

    if (existing) {
      return {
        ...existing,
        userId: request.userId
      };
    }

    const created = createSessionRecord({
      chatId: request.chatId,
      userId: request.userId
    });
    await this.sessionStore.saveSession(created);
    return created;
  }

  private requireTaskManager(): AssistantTaskManager {
    if (!this.taskManager) {
      throw new Error("Task manager is not configured.");
    }

    return this.taskManager;
  }
}
