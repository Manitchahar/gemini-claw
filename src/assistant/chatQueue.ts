export interface ChatOperationRunner {
  run<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
}

export class ChatOperationQueue implements ChatOperationRunner {
  private readonly chatQueues = new Map<string, Promise<void>>();

  async run<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);

    this.chatQueues.set(chatId, queued);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.chatQueues.get(chatId) === queued) {
        this.chatQueues.delete(chatId);
      }
    }
  }
}
