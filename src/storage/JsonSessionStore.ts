import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionRecord, SessionStore } from "./SessionStore.js";

type SessionFile = Record<string, SessionRecord>;

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async getSession(chatId: string): Promise<SessionRecord | undefined> {
    await this.writeQueue;
    const sessions = await this.readAll();
    return sessions[chatId];
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      sessions[record.chatId] = {
        ...record,
        updatedAt: new Date().toISOString()
      };
      await this.writeAll(sessions);
    });
  }

  async deleteSession(chatId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const sessions = await this.readAll();
      delete sessions[chatId];
      await this.writeAll(sessions);
    });
  }

  private async readAll(): Promise<SessionFile> {
    let raw: string;

    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await this.quarantineCorruptStore();
        return {};
      }
      throw error;
    }

    if (!isRecord(parsed)) {
      await this.quarantineCorruptStore();
      return {};
    }

    return parsed as SessionFile;
  }

  private async writeAll(sessions: SessionFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    await rename(tempPath, this.path);
  }

  private async quarantineCorruptStore(): Promise<void> {
    const quarantinePath = `${this.path}.corrupt-${Date.now()}`;

    try {
      await rename(this.path, quarantinePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    console.error(`Session store ${this.path} contained invalid JSON and was moved to ${quarantinePath}`);
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
