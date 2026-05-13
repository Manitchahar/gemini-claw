export interface AssistantRequest {
  chatId: string;
  userId: string;
  text: string;
  onEvent?: (event: AssistantEvent) => Promise<void> | void;
}

export interface AssistantTaskRequest {
  chatId: string;
  userId: string;
  text: string;
}

export type AssistantEvent =
  | {
      type: "content_delta";
      text: string;
    }
  | {
      type: "content_final";
      text: string;
    }
  | {
      type: "tool_start";
      name: string;
      raw?: unknown;
      possibleSubagentName?: string;
    }
  | {
      type: "tool_end";
      name: string;
      success: boolean;
      raw?: unknown;
      possibleSubagentName?: string;
    }
  | {
      type: "stats";
      sessionId?: string;
      raw?: unknown;
    };

export interface AssistantOptions {
  systemInstruction: string;
}

export type AssistantTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AssistantTaskSummary {
  id: string;
  chatId: string;
  userId: string;
  text: string;
  status: AssistantTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  response?: string;
  error?: string;
  tools: string[];
  failedTools: string[];
  possibleSubagents: string[];
}

export interface AssistantTaskCallbacks {
  onEvent?: (task: AssistantTaskSummary, event: AssistantEvent) => Promise<void> | void;
  onComplete?: (task: AssistantTaskSummary) => Promise<void> | void;
}

export interface WorkerStats {
  maxWorkers: number;
  maxChatWorkers: number;
  maxQueuedTasks: number;
  maxChatQueuedTasks: number;
  running: number;
  queued: number;
  runningTaskIds: string[];
  paused: boolean;
}

export interface SubagentStatus {
  extensionsConfigured: boolean;
  configuredExtensions: string[];
  observedSubagents: string[];
}
