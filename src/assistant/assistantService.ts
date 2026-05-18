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

  pauseWorkers(): WorkerStats {
    return this.requireTaskManager().pause();
  }

  resumeWorkers(): WorkerStats {
    return this.requireTaskManager().resume();
  }

  stopAllTasks(chatId?: string): AssistantTaskSummary[] {
    return this.requireTaskManager().cancelAll(chatId);
  }

  listGeminiSessions(chatId: string, userId: string): Promise<string> {
    return this.runGeminiCliCommand(["--list-sessions"], chatId, userId);
  }

  deleteGeminiSession(chatId: string, userId: string, session: string): Promise<string> {
    return this.runGeminiCliCommand(["--delete-session", session], chatId, userId);
  }

  listGeminiMcpServers(chatId: string, userId: string): Promise<string> {
    return this.runGeminiCliCommand(["mcp", "list"], chatId, userId);
  }

  listGeminiExtensions(chatId: string, userId: string): Promise<string> {
    return this.runGeminiCliCommand(["extensions", "list"], chatId, userId);
  }

  listGeminiSkills(chatId: string, userId: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "list"], chatId, userId);
  }

  linkGeminiSkill(chatId: string, userId: string, path: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "link", path], chatId, userId);
  }

  installGeminiSkill(chatId: string, userId: string, source: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "install", source], chatId, userId);
  }

  enableGeminiSkill(chatId: string, userId: string, name: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "enable", name], chatId, userId);
  }

  disableGeminiSkill(chatId: string, userId: string, name: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "disable", name], chatId, userId);
  }

  uninstallGeminiSkill(chatId: string, userId: string, name: string): Promise<string> {
    return this.runGeminiCliCommand(["skills", "uninstall", name], chatId, userId);
  }

  private async respondToTextUnlocked(request: AssistantRequest): Promise<string> {
    const session = await this.getOrCreateSession(request);
    const prompt = buildAssistantPrompt(request.text, this.options.systemInstruction);
    const contentChunks: string[] = [];
    let finalContent = "";
    let nextSessionId = session.geminiSessionId;
    const resumeSessions = this.options.resumeSessions ?? true;
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
      sessionId: resumeSessions ? session.geminiSessionId : undefined,
      extensions: detectGoogleWorkspaceRequest(request.text) ? ["google-workspace-cli"] : undefined
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

    if (!resumeSessions) {
      await this.sessionStore.saveSession({
        ...session,
        geminiSessionId: undefined
      });
    } else if (nextSessionId !== session.geminiSessionId) {
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

  private async runGeminiCliCommand(args: string[], chatId: string, userId: string): Promise<string> {
    if (!this.geminiClient.runCliCommand) {
      return "Gemini CLI management commands are not available for this backend.";
    }

    const output = await this.geminiClient.runCliCommand(args, { chatId, userId });
    return output || "Command completed with no output.";
  }
}

function detectGoogleWorkspaceRequest(text: string): boolean {
  return /\b(?:gmail|email|mails?|inbox|calendar|drive|docs?|sheets?|slides?|meet|workspace|gsuite|google\s+(?:mail|calendar|drive|docs?|sheets?|slides?))\b/i.test(
    text
  );
}
