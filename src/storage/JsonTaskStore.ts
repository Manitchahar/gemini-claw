import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AssistantTaskSummary, AssistantTaskStatus } from "../assistant/types.js";
import type { TaskStore } from "./TaskStore.js";

const TASK_STATUSES = new Set<AssistantTaskStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);

export class JsonTaskStore implements TaskStore {
  constructor(private readonly path: string) {}

  loadTasks(): AssistantTaskSummary[] {
    if (!existsSync(this.path)) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.quarantineCorruptStore();
      return [];
    }

    if (!Array.isArray(parsed)) {
      this.quarantineCorruptStore();
      return [];
    }

    return parsed.filter(isTaskSummary);
  }

  saveTasks(tasks: readonly AssistantTaskSummary[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.path);
  }

  private quarantineCorruptStore(): void {
    if (!existsSync(this.path)) {
      return;
    }

    renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
  }
}

function isTaskSummary(value: unknown): value is AssistantTaskSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.chatId === "string" &&
    typeof value.userId === "string" &&
    typeof value.text === "string" &&
    typeof value.status === "string" &&
    TASK_STATUSES.has(value.status as AssistantTaskStatus) &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.tools) &&
    Array.isArray(value.failedTools) &&
    Array.isArray(value.possibleSubagents)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
