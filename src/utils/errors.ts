export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class GeminiCliError extends Error {
  constructor(
    message: string,
    public readonly details?: {
      exitCode?: number | null;
      stderr?: string;
    }
  ) {
    super(message);
    this.name = "GeminiCliError";
  }
}
