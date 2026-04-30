import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonSessionStore } from "../src/storage/JsonSessionStore.js";
import { createSessionRecord } from "../src/storage/SessionStore.js";

describe("JsonSessionStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "telegram-gemini-assistant-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("saves, loads, and deletes sessions", async () => {
    const store = new JsonSessionStore(join(directory, "sessions.json"));
    const session = createSessionRecord({
      chatId: "chat-1",
      userId: "user-1",
      now: new Date("2025-01-01T00:00:00.000Z")
    });

    await store.saveSession(session);
    expect(await store.getSession("chat-1")).toMatchObject({
      chatId: "chat-1",
      userId: "user-1"
    });

    await store.deleteSession("chat-1");
    expect(await store.getSession("chat-1")).toBeUndefined();
  });

  it("quarantines corrupt session files and continues with an empty store", async () => {
    const storePath = join(directory, "sessions.json");
    await writeFile(storePath, "{not json", "utf8");

    const store = new JsonSessionStore(storePath);

    expect(await store.getSession("chat-1")).toBeUndefined();
    expect((await readdir(directory)).some((file) => file.startsWith("sessions.json.corrupt-"))).toBe(true);
  });

  it("quarantines valid JSON with an invalid top-level shape", async () => {
    const storePath = join(directory, "sessions.json");
    await writeFile(storePath, "[]", "utf8");

    const store = new JsonSessionStore(storePath);

    expect(await store.getSession("chat-1")).toBeUndefined();
    expect((await readdir(directory)).some((file) => file.startsWith("sessions.json.corrupt-"))).toBe(true);
  });
});
