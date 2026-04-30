export interface SessionRecord {
  chatId: string;
  userId: string;
  geminiSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  getSession(chatId: string): Promise<SessionRecord | undefined>;
  saveSession(record: SessionRecord): Promise<void>;
  deleteSession(chatId: string): Promise<void>;
}

export function createSessionRecord(input: {
  chatId: string;
  userId: string;
  geminiSessionId?: string;
  now?: Date;
}): SessionRecord {
  const timestamp = (input.now ?? new Date()).toISOString();

  return {
    chatId: input.chatId,
    userId: input.userId,
    geminiSessionId: input.geminiSessionId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
