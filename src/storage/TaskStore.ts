import type { AssistantTaskSummary } from "../assistant/types.js";

export interface TaskStore {
  loadTasks(): AssistantTaskSummary[];
  saveTasks(tasks: readonly AssistantTaskSummary[]): void;
}
