import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonTaskStore } from "../src/storage/JsonTaskStore.js";
import type { AssistantTaskSummary } from "../src/assistant/types.js";

describe("JsonTaskStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "telegram-gemini-tasks-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("saves tasks to nested directories and loads them back", () => {
    const store = new JsonTaskStore(join(directory, "nested", "tasks.json"));
    const tasks = [createTask({ id: "t-1", text: "inspect repo" }), createTask({ id: "t-2", status: "running" })];

    store.saveTasks(tasks);

    expect(store.loadTasks()).toEqual(tasks);
  });

  it("filters invalid task entries without discarding valid ones", async () => {
    const storePath = join(directory, "tasks.json");
    await writeFile(
      storePath,
      JSON.stringify(
        [
          createTask({ id: "t-1", status: "succeeded", response: "done" }),
          { id: "broken", status: "queued" },
          null
        ],
        null,
        2
      ),
      "utf8"
    );

    const store = new JsonTaskStore(storePath);

    expect(store.loadTasks()).toEqual([createTask({ id: "t-1", status: "succeeded", response: "done" })]);
  });

  it("quarantines corrupt task files and invalid top-level JSON shapes", async () => {
    const corruptPath = join(directory, "corrupt.json");
    await writeFile(corruptPath, "{not json", "utf8");

    const corruptStore = new JsonTaskStore(corruptPath);
    expect(corruptStore.loadTasks()).toEqual([]);
    expect((await readdir(directory)).some((file) => file.startsWith("corrupt.json.corrupt-"))).toBe(true);

    const invalidPath = join(directory, "invalid.json");
    await writeFile(invalidPath, JSON.stringify({ nope: true }), "utf8");

    const invalidStore = new JsonTaskStore(invalidPath);
    expect(invalidStore.loadTasks()).toEqual([]);
    expect((await readdir(directory)).some((file) => file.startsWith("invalid.json.corrupt-"))).toBe(true);
  });
});

function createTask(overrides: Partial<AssistantTaskSummary> = {}): AssistantTaskSummary {
  return {
    id: "t-0001",
    chatId: "chat-1",
    userId: "user-1",
    text: "inspect repo",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    tools: [],
    failedTools: [],
    possibleSubagents: [],
    ...overrides
  };
}
