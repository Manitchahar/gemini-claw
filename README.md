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
   GEMINI_MAX_WORKERS=3
   GEMINI_MAX_CHAT_WORKERS=3
   GEMINI_MAX_QUEUED_TASKS=50
   GEMINI_MAX_CHAT_QUEUED_TASKS=10
   GEMINI_TASK_HISTORY_LIMIT=20
   GEMINI_WORKER_SESSION_MODE=isolated
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
- `/task <prompt>` - starts a concurrent background Gemini CLI worker
- `/tasks` - lists running and recent tasks for this Telegram chat
- `/task_status <id>` - shows task status, result preview, tools, and observed subagents
- `/cancel <id>` - cancels a queued task or terminates a running Gemini CLI worker
- `/workers` - shows worker limits, running count, queued count, and active task IDs
- `/subagents` - explains SDK support and shows configured/observed subagent state

Plain text chat remains sequential so the normal Gemini CLI session mapping stays safe. Use `/task` when you want multiple independent jobs to run at once.

## Background workers

Each `/task` starts a task record and returns immediately with an ID such as `t-0001`. When capacity is available, the task manager starts a separate `gemini` subprocess for that worker. Completed task summaries stay in memory for `/tasks` and `/task_status`.

Worker settings:

```bash
GEMINI_MAX_WORKERS=3
GEMINI_MAX_CHAT_WORKERS=3
GEMINI_MAX_QUEUED_TASKS=50
GEMINI_MAX_CHAT_QUEUED_TASKS=10
GEMINI_TASK_HISTORY_LIMIT=20
GEMINI_WORKER_SESSION_MODE=isolated
```

`GEMINI_MAX_QUEUED_TASKS` and `GEMINI_MAX_CHAT_QUEUED_TASKS` bound the backlog so an allowlisted but compromised account cannot enqueue unlimited work.

`GEMINI_WORKER_SESSION_MODE=isolated` is the safe default: background tasks do not share the normal chat's Gemini CLI resume session, so concurrent workers cannot corrupt one another's context. `GEMINI_WORKER_SESSION_MODE=chat` lets workers use the chat session mapping; in that mode, the bot forces same-chat workers to run one at a time to protect the shared Gemini session.

Cancellation is best-effort. `/cancel <id>` can stop a queued task or send termination to the Gemini CLI child process, but it cannot undo external tool side effects that already happened before cancellation.

## Gemini integration

The app invokes:

```bash
gemini --prompt "<assistant prompt>" --output-format json
```

When a Gemini session ID is returned, later messages resume it with `--resume <session_id>`. Set `GEMINI_OUTPUT_FORMAT=stream-json` to parse Gemini CLI JSONL events. The adapter is isolated behind `GeminiClient`; the CLI subprocess remains the default because it uses the published `@google/gemini-cli`, while `SdkGeminiClient` is intentionally kept only as a future adapter seam until a stable first-party SDK package is available.

## Subagents and extensions

Subagents and richer tools come from Gemini CLI extensions, not from Telegram-specific code. The first-party Gemini CLI SDK does not provide subagents by default; this app intentionally stays on the stable `gemini` subprocess protocol. Configure extensions with environment variables that map directly to Gemini CLI flags:

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

The bot reports subagents honestly:

- `Subagent: observed <name>` means stream events exposed a subagent-like tool/agent name.
- `Subagent: not observed` means the task did not emit subagent evidence.
- `Subagent: unavailable` means no extension/subagent configuration is present.

## Safety defaults

- Telegram allowlist is mandatory.
- Tool-rich operation and YOLO mode are explicit opt-ins, not defaults.
- Concurrent worker mode is explicit through `/task`; normal chat is still serialized.
- v1 is chat-only by default and does not expose local shell or filesystem tools through Telegram unless you configure Gemini CLI tools, MCP servers, extensions, or YOLO-style autonomy.
- Use YOLO/tool-rich/multi-worker modes only on trusted machines with trusted repositories and accounts. These modes can read or change local resources, run tools, and amplify prompt-injection or account-compromise impact.
- Treat Telegram allowlisting as necessary but not sufficient. If an allowlisted account is compromised, or if untrusted content persuades the model through prompt injection, the bot may act on attacker-controlled instructions.
- The app stores only chat/user/session metadata in `.data/sessions.json` by default, not full message transcripts.
