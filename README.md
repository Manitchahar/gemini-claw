# Telegram Gemini Assistant

A small TypeScript Telegram bot that delegates personal-assistant requests to the official `gemini` CLI through its JSON/JSONL automation protocol.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install and authenticate the Gemini CLI so `gemini` is available on `PATH`:

   ```bash
   npm install -g @google/gemini-cli
   gemini
   ```

   Complete the CLI's auth flow when prompted. If you already have a Gemini CLI install elsewhere, set `GEMINI_CLI_COMMAND` to that absolute command path.

3. Create a Telegram bot with BotFather, then copy `.env.example` to `.env` and fill in:

   ```bash
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```

   `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list. Messages from any other Telegram user are rejected before Gemini is invoked.

## Run locally

```bash
npm run dev
```

The bot uses long polling for local development.

For privacy, the bot only responds in direct Telegram chats. Even allowlisted users are rejected in groups and supergroups so assistant output is not exposed to other chat members.

## Commands

- `/start` - introduction
- `/help` - usage notes
- `/reset` - clears the local session mapping for the current chat

## Gemini integration

The app invokes:

```bash
gemini --prompt "<assistant prompt>" --output-format json
```

When a Gemini session ID is returned, later messages resume it with `--resume <session_id>`. Set `GEMINI_OUTPUT_FORMAT=stream-json` to parse Gemini CLI JSONL events. The adapter is isolated behind `GeminiClient` so a future first-party `@google/gemini-cli-sdk` implementation can replace the subprocess path.

## Safety defaults

- Telegram allowlist is mandatory.
- v1 is chat-only and does not expose local shell or filesystem tools through Telegram.
- The app stores only chat/user/session metadata in `.data/sessions.json` by default, not full message transcripts.
