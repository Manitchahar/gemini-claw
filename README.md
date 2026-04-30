# Gemini Claw

Telegram-native Gemini CLI personal AI operator with private allowlisted chats.

Gemini Claw turns a Telegram bot into a private operator interface for the official `gemini` CLI. It keeps the transport small, typed, and safe by default: only allowlisted Telegram users can talk to it, it only works in private chats, and the Gemini integration is isolated behind a replaceable adapter.

## Why it is useful

- Chat with Gemini CLI from Telegram without exposing a public web UI.
- Keep local session continuity through Gemini CLI session IDs.
- Use JSON or stream-JSON output parsing for automation-friendly responses.
- Keep secrets and local session data out of git by default.
- Upgrade toward tool-rich autonomy without making Telegram an unrestricted remote shell.

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
   GEMINI_CLI_COMMAND=gemini
   GEMINI_APPROVAL_MODE=default
   GEMINI_SANDBOX=false
   GEMINI_DEBUG=false
   GEMINI_CWD=.
   GEMINI_ALLOWED_TOOLS=
   GEMINI_ALLOWED_MCP_SERVER_NAMES=
   GEMINI_EXTENSIONS=
   GEMINI_INCLUDE_DIRECTORIES=
   GEMINI_SETTINGS=
   GEMINI_YOLO=false
   ```

   `TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list. Messages from any other Telegram user are rejected before Gemini is invoked. This allowlist is mandatory, but it is not a complete safety boundary: a compromised Telegram account or a prompt-injection attack can still issue harmful instructions through an otherwise trusted chat.

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
- `/status` - current session and mode summary
- `/tools` - configured Gemini tools and extensions
- `/plan` - current plan, if available
- `/yolo` - YOLO mode status and warnings

## Gemini integration

The app invokes:

```bash
gemini --prompt "<assistant prompt>" --output-format json
```

When a Gemini session ID is returned, later messages resume it with `--resume <session_id>`. Set `GEMINI_OUTPUT_FORMAT=stream-json` to parse Gemini CLI JSONL events. The adapter is isolated behind `GeminiClient`; the CLI subprocess remains the default because it uses the published `@google/gemini-cli`, while `SdkGeminiClient` is intentionally kept only as a future adapter seam until a stable first-party SDK package is available.

## Subagents and extensions

Subagents and richer tools come from Gemini CLI extensions, not from Telegram-specific code. Configure them with environment variables that map directly to Gemini CLI flags:

```bash
GEMINI_EXTENSIONS=my-extension,my-agent-pack
GEMINI_ALLOWED_MCP_SERVER_NAMES=github,filesystem
GEMINI_ALLOWED_TOOLS=ReadFile,Shell
GEMINI_INCLUDE_DIRECTORIES=src,tests
GEMINI_SETTINGS=/home/me/.gemini/settings.json
GEMINI_APPROVAL_MODE=default
GEMINI_SANDBOX=false
GEMINI_DEBUG=false
GEMINI_CWD=/home/me/projects/trusted-repo
GEMINI_YOLO=false
```

Use `GEMINI_EXTENSIONS` for extension or subagent packages, `GEMINI_ALLOWED_MCP_SERVER_NAMES` for MCP servers exposed by Gemini CLI settings, `GEMINI_ALLOWED_TOOLS` to limit tools, `GEMINI_INCLUDE_DIRECTORIES` to constrain project context, `GEMINI_SETTINGS` to point at a Gemini CLI settings file, and `GEMINI_CWD` to run Gemini from a specific working directory. `GEMINI_APPROVAL_MODE`, `GEMINI_SANDBOX`, and `GEMINI_YOLO` control how much autonomy Gemini gets; keep them conservative unless the machine, repository, account, and extensions are trusted. `GEMINI_DEBUG=true` enables extra diagnostics and may reveal operational details in logs.

## Safety defaults

- Telegram allowlist is mandatory.
- Tool-rich operation and YOLO mode are explicit opt-ins, not defaults.
- v1 is chat-only by default and does not expose local shell or filesystem tools through Telegram unless you configure Gemini CLI tools, MCP servers, extensions, or YOLO-style autonomy.
- Use YOLO/tool-rich modes only on trusted machines with trusted repositories and accounts. These modes can read or change local resources, run tools, and amplify prompt-injection or account-compromise impact.
- Treat Telegram allowlisting as necessary but not sufficient. If an allowlisted account is compromised, or if untrusted content persuades the model through prompt injection, the bot may act on attacker-controlled instructions.
- The app stores only chat/user/session metadata in `.data/sessions.json` by default, not full message transcripts.
