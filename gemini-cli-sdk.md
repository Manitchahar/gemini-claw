# Gemini CLI SDK research report

## Executive Summary

"Gemini CLI SDK" currently refers to three related but distinct surfaces: the first-party `@google/gemini-cli-sdk` workspace inside [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli), the published first-party CLI/core packages `@google/gemini-cli` and `@google/gemini-cli-core`, and community SDK wrappers around either the CLI subprocess or `@google/gemini-cli-core`.[^1] The first-party SDK source is real and implements a Node/TypeScript `GeminiCliAgent`, `GeminiCliSession`, `tool()`, `skillDir()`, filesystem/shell context helpers, and typed stream events, but I did not find it published on npm under `@google/gemini-cli-sdk` at research time despite its README saying `npm install @google/gemini-cli-sdk`.[^2]

For production automation today, the most stable public integration surface appears to be the `gemini` executable in non-interactive mode with `--output-format json` or `--output-format stream-json`, because those formats are implemented in the CLI/core packages and used by Google's own [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) action.[^3] If you are trying to extend the Gemini CLI itself, extensions/MCP servers are the supported user-facing extensibility path; if you are trying to embed an agent inside a Node process, the new first-party SDK is promising but still has maturity caveats.[^4]

## Query interpretation

I treated the query as a technical deep-dive into the current Gemini CLI SDK ecosystem, not just an install command. The term is ambiguous because there is a first-party SDK workspace, a first-party core package, official CLI automation/headless APIs, official extension/MCP mechanisms, and several community packages that market themselves as Gemini CLI SDKs.[^5]

## Key repositories and packages

| Repository / package | Role | Status observed | Key files |
|---|---|---:|---|
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Official Gemini CLI monorepo; contains `@google/gemini-cli`, `@google/gemini-cli-core`, and source for `@google/gemini-cli-sdk`. | Official source of truth. Local snapshot: `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`. | `packages/sdk/src/*`, `packages/cli/src/nonInteractiveCli.ts`, `packages/core/src/output/*` |
| [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) | Official GitHub Action wrapper around the CLI. | Published action pattern for CI automation. Snapshot: `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`. | `action.yml`, `README.md` |
| [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) / `@k2wanko/gemini-cli-sdk` | Community Node SDK built on `@google/gemini-cli-core`. | Published npm package `0.5.0`; depends on core `nightly`. Snapshot: `3cd4aff82c41b111562b6ee91e90598b183d3ce0`. | `src/agent.ts`, `src/tool.ts`, `src/subagent.ts` |
| [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) / `ai-sdk-provider-gemini-cli` | Community Vercel AI SDK provider using Gemini CLI core. | Published npm package `2.0.1`; targets AI SDK v6. Snapshot: `c166ff65c8ee004ed345d65d9630148b3586ac13`. | `src/gemini-provider.ts`, `src/gemini-language-model.ts`, `src/client.ts` |
| [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) / `gemini_cli_sdk` | Community Elixir SDK wrapping the `gemini` subprocess. | Published Hex package `0.2.0`. Snapshot: `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`. | `lib/gemini_cli_sdk.ex`, `lib/gemini_cli_sdk/stream.ex`, `lib/gemini_cli_sdk/runtime/cli.ex` |

## Architecture overview

There are two practical integration architectures:

```text
Node app
  └─ @google/gemini-cli-sdk (source workspace)
       ├─ GeminiCliAgent
       ├─ GeminiCliSession
       ├─ tool() / SdkTool / zod-to-json-schema
       └─ @google/gemini-cli-core
            ├─ Config / Auth / GeminiClient
            ├─ ToolRegistry / scheduleAgentTools
            ├─ SkillManager / ActivateSkillTool
            └─ ShellTool / ShellExecutionService
```

```text
Shell / CI / non-Node runtime
  └─ gemini executable
       ├─ --prompt / -p
       ├─ --output-format json
       └─ --output-format stream-json
            ├─ init
            ├─ message
            ├─ tool_use
            ├─ tool_result
            ├─ error
            └─ result
```

The first path embeds the agent loop directly in a Node process via `@google/gemini-cli-core`; the second treats Gemini CLI as a subprocess protocol with JSON or JSONL output.[^6] Community packages map onto one of those two paths: `@k2wanko/gemini-cli-sdk` embeds `@google/gemini-cli-core`, `ai-sdk-provider-gemini-cli` adapts core's content generator to Vercel AI SDK, and `gemini_cli_sdk` spawns `gemini --output-format stream-json` from Elixir.[^7]

## First-party SDK: `@google/gemini-cli-sdk`

### Packaging and publish status

The official monorepo contains `packages/sdk/package.json` with package name `@google/gemini-cli-sdk`, Apache-2.0 license, Node `>=20`, and dependencies on local `@google/gemini-cli-core`, `zod`, and `zod-to-json-schema`.[^8] Its README presents `npm install @google/gemini-cli-sdk` and a `GeminiCliAgent` streaming example.[^9] However, `npm view @google/gemini-cli-sdk` returned `E404 Not Found` during this research, while `@google/gemini-cli` and `@google/gemini-cli-core` were published at `0.40.0` with `preview` and `nightly` dist-tags.[^10] That makes the SDK a source-visible first-party workspace, but not yet a consumable public npm package in the same way as the CLI/core packages.

### Public API

The first-party SDK exports `agent`, `session`, `tool`, `skills`, and `types` modules from `src/index.ts`.[^11] The main class is `GeminiCliAgent`, which stores the provided options, creates new sessions with either a caller-provided session ID or a generated one, and can resume a prior saved session by scanning the Gemini CLI project chat storage and matching the full session ID.[^12]

The minimal usage pattern is:

```ts
import { GeminiCliAgent } from '@google/gemini-cli-sdk';

const agent = new GeminiCliAgent({
  instructions: 'You are a helpful assistant.',
});

const session = agent.session();

for await (const event of session.sendStream('Why is the sky blue?')) {
  if (event.type === 'content') {
    process.stdout.write(event.value.text ?? '');
  }
}
```

This example matches the README intent, but the exact event value shape should be checked against the current `@google/gemini-cli-core` `ServerGeminiStreamEvent` type in the version you consume because the SDK yields core stream events directly.[^13]

### Session lifecycle and model/auth setup

`GeminiCliSession` constructs a core `Config` with `sessionId`, `targetDir`, `cwd`, debug flag, model, and initial user memory derived from static instructions.[^14] If no model is supplied, the SDK uses `PREVIEW_GEMINI_MODEL_AUTO`.[^15] During initialization, it chooses `getAuthTypeFromEnv()` when available and otherwise defaults to `AuthType.COMPUTE_ADC`, then calls `config.refreshAuth()` and `config.initialize()`.[^16]

The core SDK config intentionally starts from a restricted/minimal surface: hooks are disabled, MCP is disabled, extensions are disabled, skills support is enabled, admin skills are enabled, and the policy engine's default decision is `ALLOW`.[^17] That means a programmatic SDK session is not automatically equivalent to an interactive CLI session with all extension/MCP behavior enabled.

### Instructions

`GeminiCliAgentOptions.instructions` accepts either a string or a function receiving `SessionContext`.[^18] String instructions are set as initial `userMemory`; dynamic instructions are recomputed inside `sendStream`, written to `config.setUserMemory()`, and followed by `client.updateSystemInstruction()` before the message stream is sent.[^19] Integration tests verify that static instructions influence model output, dynamic instructions can change across turns, invalid instruction types throw, and dynamic-instruction exceptions propagate rather than being swallowed.[^20]

### Tool API

The first-party SDK's `tool()` helper accepts a name, description, Zod input schema, and async action.[^21] Internally, `SdkTool` extends core `BaseDeclarativeTool`, converts the Zod input schema to JSON schema, and registers the tool in the core tool registry.[^22] Tool execution serializes string results as-is and non-string results with `JSON.stringify(result, null, 2)`.[^23] By default, normal errors are thrown; errors become model-visible only when `sendErrorsToModel` is set or when the action throws `ModelVisibleError`.[^24]

A representative custom tool:

```ts
import { GeminiCliAgent, tool, z } from '@google/gemini-cli-sdk';

const add = tool(
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: z.object({
      a: z.number().describe('the first number'),
      b: z.number().describe('the second number'),
    }),
  },
  async ({ a, b }) => ({ result: a + b }),
);

const agent = new GeminiCliAgent({
  instructions: 'Be concise.',
  tools: [add],
});
```

The official SDK example uses the same pattern and streams all returned chunks from `agent.sendStream()`.[^25]

### Tool-call loop

`sendStream()` sends the prompt through `GeminiClient.sendMessageStream()`, yields every stream event to the caller, collects `ToolCallRequest` events, parses stringified tool arguments if needed, then schedules tools through core `scheduleAgentTools()`.[^26] Before scheduling, the SDK clones/scopes the tool registry so `SdkTool` instances are rebound with the current `SessionContext`.[^27] Completed tool response parts are flattened and fed back as the next `sendMessageStream()` request, producing a standard model-tool-model loop until no tool calls remain.[^28]

### Session context, filesystem, and shell helpers

`SessionContext` contains `sessionId`, transcript, `cwd`, timestamp, filesystem helper, shell helper, agent, and session.[^29] `SdkAgentFilesystem` validates path access through `config.validatePathAccess()` before reads or writes; denied reads currently return `null`, denied writes throw, and file read errors also return `null`.[^30] `SdkAgentShell.exec()` builds a core `ShellTool` invocation, refuses commands that require confirmation because there is no interactive session, and then executes via `ShellExecutionService.execute()` with `shouldUseNodePty: false`.[^31]

Security implication: SDK users should treat prompt/tool inputs as privileged code-adjacent inputs. The default SDK policy engine decision is `ALLOW`, but shell execution still checks the core shell tool's confirmation path and fails closed if a confirmation would be required.[^32]

### Skills

The source has a `skillDir(path)` helper that returns `{ type: 'dir', path }`.[^33] During initialization, `GeminiCliSession` loads each skill directory with core `loadSkillsFromDir()`, adds loaded skills to the skill manager, and re-registers `ActivateSkillTool` when skills exist so the tool schema reflects the loaded skills.[^34] Integration tests cover loading and activating a skill from both a single skill directory and a skill root.[^35]

The design document has inconsistent status language: its header says "Advanced features like hooks, skills, subagents, and ACP are currently missing", but a later section marks custom skills as implemented, and the source/tests confirm skills are implemented.[^36]

### Missing or immature first-party SDK areas

The design document explicitly marks custom hooks, subagents, extensions, ACP mode, and approvals/policies as not implemented in the SDK design examples.[^37] A unit-test block for `GeminiCliSession sendStream()` is skipped with a TODO noting the mock expected `getGeminiClient()` while `session.ts` expects a `geminiClient` property; integration tests still exercise the behavior with fake/recorded responses, but this is a maturity signal.[^38]

## Official CLI non-interactive/headless API

The CLI supports `--output-format` choices `text`, `json`, and `stream-json`; invalid values are rejected during argument validation.[^39] Core defines the same `OutputFormat` enum and structured JSONL event model with event types `init`, `message`, `tool_use`, `tool_result`, `error`, and `result`.[^40]

For `stream-json`, the non-interactive CLI emits an initial `init` event with timestamp, session ID, and model; emits user and assistant message events; emits `tool_use` and `tool_result` events around scheduled tools; and emits a final `result` event with status and stats.[^41] `StreamJsonFormatter` writes each event as newline-delimited JSON to stdout and computes aggregate/per-model token and tool-call stats.[^42] For `json`, `JsonFormatter` returns a single JSON object with optional `session_id`, `response`, `stats`, and `error` fields.[^43]

Authentication in non-interactive mode requires either configured auth or environment-based auth. The CLI checks configured auth or `getAuthTypeFromEnv()`, and if none exists it asks the user to set an auth method or one of `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, or `GOOGLE_GENAI_USE_GCA`.[^44]

## Official extensions/MCP surface

If the goal is to add capabilities to Gemini CLI itself rather than embed the agent loop, extensions are the intended supported path. The extension guide says extensions can add MCP servers, custom commands, context files, agent skills, hooks, and themes.[^45] A `gemini-extension.json` manifest can define `mcpServers`, `contextFileName`, `excludeTools`, settings, themes, and planning configuration.[^46]

For tools and external systems, MCP is the most important mechanism. Gemini CLI's MCP docs describe discovery through configured `mcpServers`, connection over Stdio/SSE/Streamable HTTP, tool schema fetching, tool registry registration, resource discovery, and execution through `DiscoveredMCPTool` wrappers.[^47] The extension reference states that extension MCP servers are loaded on startup like settings-defined MCP servers, that settings-defined servers take precedence on name conflicts, and that extension MCP config should use `${extensionPath}` for portability.[^48]

Extensions also support command TOML files in `commands/`, hooks in `hooks/hooks.json`, skills under `skills/<name>/SKILL.md`, sub-agent definitions in `agents/`, and policy rules in `policies/*.toml`.[^49] Extension policy rules run in their own tier alongside workspace-defined policies, but the docs warn that extension policies cannot use `allow` or `yolo` decisions to bypass user security confirmation.[^50]

## Official GitHub Action integration

[google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) is the official CI/workflow wrapper. Its README says it integrates Gemini CLI into GitHub workflows for PR review, issue triage, code analysis/modification, and comment-triggered collaboration.[^51] The action accepts auth inputs for Gemini API key, Vertex AI/Google API key, or Workload Identity Federation; accepts CLI version, model, prompt, settings JSON, and extensions; and exposes `summary` and `error` outputs.[^52]

The action installs `@google/gemini-cli` from npm for `latest`, `preview`, `nightly`, or semver versions, or clones the official repo and bundles it for branch/tag/commit installs.[^53] It then runs `gemini --yolo --prompt "${PROMPT}" --output-format json`, captures stdout/stderr to temporary files, copies logs into artifacts, parses `.response` from stdout JSON and `.error` from stderr JSON, and fails the workflow if the CLI command failed.[^54]

This is strong evidence that `--output-format json` is Google's own preferred automation contract for GitHub Actions, whereas the SDK workspace is not yet the only or most proven automation route.[^55]

## Community Node SDK: `@k2wanko/gemini-cli-sdk`

[k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) is a published community package (`0.5.0`) that depends on `@google/gemini-cli-core` with the `nightly` tag.[^56] Its design document says it is a lightweight, type-safe SDK for non-interactive agents, built on core but exposing its own API surface instead of re-exporting core internals.[^57]

Its `GeminiAgent` options include instructions, custom tools, skills, model, cwd, debug, session resume ID, compression threshold, log control, and hooks.[^58] Unlike the first-party SDK source, this community SDK enables hooks when hook definitions are provided, disables MCP and extensions, enables skills, sets policy default `ALLOW`, disables loop detection, and supports compression threshold.[^59] Its agent loop is similar to the first-party SDK: initialize core config/auth, optionally resume a session, load skills, register tools, stream model events, extract tool calls, schedule tools, and feed function responses back to Gemini.[^60]

The community package also goes beyond the current first-party SDK by implementing sub-agent helpers. `defineSubAgent()` wraps local sub-agent definitions as tools, `loadSubAgents()` loads local or remote agent definitions from markdown files, local agents execute through core `LocalAgentExecutor`, and remote agents use the A2A SDK `ClientFactory` to send blocking messages to an agent-card URL.[^61]

Trade-off: this wrapper is more featureful in some areas, but it is not official and is pinned to core `nightly`, which can break as internal core APIs evolve.[^62]

## Community Vercel AI SDK provider: `ai-sdk-provider-gemini-cli`

[ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) is a Vercel AI SDK provider, not a full Gemini CLI agent SDK. It exposes `createGeminiProvider`, a ProviderV3-compatible function that returns `GeminiLanguageModel` instances, and explicitly throws `NoSuchModelError` for embedding and image models.[^63] Its package depends on `@google/gemini-cli-core` `0.22.4`, `@google/genai` `1.30.0`, Google auth libraries, and AI SDK provider packages.[^64]

The provider maps auth types to core `AuthType`: API key/Gemini API key to `USE_GEMINI`, Vertex AI to `USE_VERTEX_AI`, OAuth/OAuth personal to `LOGIN_WITH_GOOGLE`, and Google Auth Library currently falls back to `USE_GEMINI` in the source.[^65] It constructs a proxy-backed config shim with many "safe default" getter methods and passes that into core `createContentGeneratorConfig()` and `createContentGenerator()`.[^66]

The language model supports AI SDK v6 generation and streaming, maps AI SDK messages to Gemini `Content`, passes system messages as `systemInstruction`, maps multimodal file parts to inline base64 for images/audio/video/PDF, maps AI SDK function tools to Gemini function declarations, and supports native structured outputs through `responseJsonSchema` when a JSON schema is provided.[^67] It also carries `thoughtSignature` provider metadata for Gemini 3 tool loops, which the latest commit message says was added because Gemini 3 thinking models require signatures on all function-call parts during multi-turn tool loops.[^68]

Limitations are visible in source: image URLs are not supported, URL file parts throw, abort signals cannot cancel in-flight core requests/streams directly, and JSON mode without a schema is downgraded to text/plain with a warning.[^69]

## Community Elixir SDK: `gemini_cli_sdk`

[nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) is an Elixir SDK published on Hex as `0.2.0`.[^70] It is a subprocess wrapper: `GeminiCliSdk.execute/2` returns a lazy stream, backed by `Stream.resource/3`, that spawns `gemini` with `--output-format stream-json` and `--prompt`, yields one typed event per JSONL line, and kills/cleans up the subprocess when halted or complete.[^71]

The Elixir public API offers streaming `execute/2`, synchronous `run/2`, session listing, typed session entries, session resume, session delete, and version detection.[^72] Its options map directly to CLI flags or subprocess settings: model, yolo, approval mode, sandbox, resume, extensions, include directories, allowed tools, allowed MCP server names, debug, output format, cwd, env, settings, system prompt, timeout, and stderr buffer size.[^73] The argument builder emits `--prompt`, `--output-format`, `--model`, `--approval-mode`, `--yolo`, `--sandbox`, `--resume`, `--extensions`, `--include-directories`, `--allowed-tools`, `--allowed-mcp-server-names`, and `--debug` as appropriate.[^74]

Its runtime projects raw JSONL event types into typed Elixir structs for `init`, `message`, `tool_use`, `tool_result`, `error`, and `result`, and it treats `ResultEvent` or fatal `ErrorEvent` as final stream events.[^75] This is the best fit if you want an Elixir-native API over the CLI's subprocess protocol, not a Node embedding API.

## Recommendations

1. **For Node embedding:** use the first-party `packages/sdk` design if you can vendor or work from the monorepo/nightly source, but do not assume `npm install @google/gemini-cli-sdk` works until the package appears in npm. The code is real, but npm publish status is not there yet.[^76]
2. **For CI and automation:** prefer `gemini -p "..." --output-format json` for request/response jobs and `--output-format stream-json` when you need real-time events. This path is implemented in official CLI/core and used by the official GitHub Action.[^77]
3. **For extending Gemini CLI:** build an extension with an MCP server, commands, context, skills, hooks, or policies. Do not use the programmatic SDK for CLI user-facing extension distribution unless you are embedding a separate app.[^78]
4. **For Vercel AI SDK apps:** `ai-sdk-provider-gemini-cli` is the closest drop-in adapter, with good AI SDK v6 coverage and tool/structured-output support, but it is community-maintained and relies on core internals/config shims.[^79]
5. **For Elixir apps:** `gemini_cli_sdk` is the most idiomatic wrapper found, and it correctly treats the CLI as a JSONL subprocess protocol rather than trying to bind Node internals.[^80]
6. **For security-sensitive usage:** avoid exposing SDK tools or `--yolo` automation to untrusted prompts. Both the first-party SDK and community SDKs lean toward non-interactive execution, and the first-party SDK sets the default policy decision to `ALLOW`.[^81]

## Confidence Assessment

**High confidence:** The official monorepo contains a first-party SDK workspace with the public APIs and implementation described above; the CLI/core non-interactive JSON and JSONL formats are implemented in source; extensions/MCP are official extensibility mechanisms; and the official GitHub Action invokes the CLI with JSON output.[^82]

**Medium confidence:** The first-party SDK's external release plan. The source and README imply a package named `@google/gemini-cli-sdk`, but npm returned `E404` during this research. That could change quickly after this snapshot.[^83]

**Medium confidence:** Community package suitability for production. Their code and package metadata are visible, but they are not official Google packages; several depend on core internals or a `nightly` tag, so compatibility risk is higher than the CLI subprocess protocol.[^84]

## Footnotes

[^1]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/package.json:1-36` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/core/package.json:1-120` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `package.json:1-58` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`); [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `package.json:1-101` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`); [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `mix.exs:1-120` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^2]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/agent.ts:19-87`, `packages/sdk/src/session.ts:38-87`, `packages/sdk/src/tool.ts:22-155`, `packages/sdk/src/skills.ts:7-16`, `packages/sdk/src/types.ts:13-61` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); `npm view @google/gemini-cli-sdk version dist-tags description repository.url license --json` returned `E404 Not Found` during research on 2026-04-29.
[^3]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/cli/src/config/config.ts:255-260`, `packages/core/src/output/types.ts:9-116`, `packages/cli/src/nonInteractiveCli.ts:236-243`, `packages/cli/src/nonInteractiveCli.ts:285-352`, `packages/cli/src/nonInteractiveCli.ts:417-546` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:286-368` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^4]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/writing-extensions.md:1-25`, `docs/extensions/reference.md:104-177`, `docs/tools/mcp-server.md:26-62` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/SDK_DESIGN.md:92-250`, `packages/sdk/src/session.test.ts:184-185` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^5]: GitHub repository search results during research found [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli), [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk), [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli), [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk), [managedcode/GeminiSharpSDK](https://github.com/managedcode/GeminiSharpSDK), and other Gemini CLI-related SDK/wrapper repositories.
[^6]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:7-25`, `packages/sdk/src/session.ts:171-275`, `packages/core/src/output/types.ts:28-116`, `packages/core/src/output/stream-json-formatter.ts:14-88` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^7]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `src/agent.ts:1-20`, `src/agent.ts:121-190` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`); [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/client.ts:1-10`, `src/client.ts:164-190` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`); [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk.ex:37-49`, `lib/gemini_cli_sdk/stream.ex:52-85` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^8]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/package.json:1-36` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^9]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/README.md:1-36` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^10]: `npm view @google/gemini-cli-sdk ...` returned npm `E404`; `npm view @google/gemini-cli-core ...` returned `version: 0.40.0`, `dist-tags.nightly: 0.42.0-nightly.20260429.g6d9911393`, `dist-tags.preview: 0.41.0-preview.0`; `npm view @google/gemini-cli ...` returned the same version/dist-tags. Corroborating source package names are in [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/package.json:1-36`, `packages/core/package.json:1-120`, and `packages/cli/package.json:1-91` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^11]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/index.ts:7-11` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^12]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/agent.ts:19-87` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^13]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/README.md:14-35`, `packages/sdk/src/session.ts:171-174` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^14]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:47-87` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^15]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:65-71` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^16]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:93-100` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^17]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:72-84` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^18]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/types.ts:13-27` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^19]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:58-63`, `packages/sdk/src/session.ts:189-204` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^20]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/agent.integration.test.ts:29-100`, `packages/sdk/src/agent.integration.test.ts:141-171` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^21]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/tool.ts:29-38`, `packages/sdk/src/tool.ts:147-155` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^22]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/tool.ts:91-145`, `packages/sdk/src/session.ts:139-147` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^23]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/tool.ts:62-73` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^24]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/tool.ts:22-27`, `packages/sdk/src/tool.ts:74-87`, `packages/sdk/src/tool.test.ts:71-148` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^25]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/tool.integration.test.ts:24-60`, `packages/sdk/examples/simple.ts:7-38` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^26]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:171-225` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^27]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:232-263`, `packages/sdk/src/tool.ts:111-129` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^28]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:256-274`, `packages/sdk/src/session.test.ts:227-284` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^29]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/types.ts:52-61` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^30]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/fs.ts:11-35` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^31]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/shell.ts:19-74` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^32]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:80-83`, `packages/sdk/src/shell.ts:38-63` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^33]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/skills.ts:7-16` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^34]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:101-137` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^35]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/skills.integration.test.ts:25-91` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^36]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/SDK_DESIGN.md:1-5`, `packages/sdk/SDK_DESIGN.md:147-150`, `packages/sdk/src/session.ts:101-137`, `packages/sdk/src/skills.integration.test.ts:25-91` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^37]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/SDK_DESIGN.md:92-145`, `packages/sdk/SDK_DESIGN.md:180-250` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^38]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.test.ts:184-185`, `packages/sdk/src/session.test.ts:227-331`, `packages/sdk/src/tool.integration.test.ts:23-149` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^39]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/cli/src/config/config.ts:255-260`, `packages/cli/src/config/config.ts:455-461` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^40]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/core/src/output/types.ts:9-116` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^41]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/cli/src/nonInteractiveCli.ts:236-243`, `packages/cli/src/nonInteractiveCli.ts:285-352`, `packages/cli/src/nonInteractiveCli.ts:417-546`; equivalent `LegacyAgentSession` path in `packages/cli/src/nonInteractiveCliAgentSession.ts:237-245`, `packages/cli/src/nonInteractiveCliAgentSession.ts:281-289`, `packages/cli/src/nonInteractiveCliAgentSession.ts:453-492`, `packages/cli/src/nonInteractiveCliAgentSession.ts:562-593` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^42]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/core/src/output/stream-json-formatter.ts:14-88` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^43]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/core/src/output/json-formatter.ts:12-53`, `packages/core/src/output/types.ts:15-26` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^44]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/cli/src/validateNonInterActiveAuth.ts:20-65` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^45]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/writing-extensions.md:1-25` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^46]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/reference.md:104-177`, `packages/cli/src/config/extension.ts:17-49` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^47]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/tools/mcp-server.md:1-62`, `docs/tools/mcp-server.md:90-189` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^48]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/reference.md:146-157` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^49]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/reference.md:213-253` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^50]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/reference.md:245-260`, `docs/extensions/writing-extensions.md:260-283` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^51]: [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `README.md:1-47`, `README.md:118-147` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^52]: [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:20-109`, `README.md:151-215` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^53]: [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:236-284` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^54]: [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:286-431` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^55]: [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:304-318`, `action.yml:332-368` (commit `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^56]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `package.json:1-58` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`); `npm view @k2wanko/gemini-cli-sdk version description repository.url license --json` returned `version: 0.5.0`.
[^57]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `DESIGN.md:1-35`, `DESIGN.md:37-57` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^58]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `src/agent.ts:39-56`, `DESIGN.md:58-83` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^59]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `src/agent.ts:78-98` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^60]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `src/agent.ts:121-190`, `src/agent.ts:198-265`, `src/agent.ts:267-315` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^61]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `src/subagent.ts:1-13`, `src/subagent.ts:45-78`, `src/subagent.ts:84-175`, `src/subagent.ts:224-328` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^62]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `package.json:45-50`, `DESIGN.md:29-35` (commit `3cd4aff82c41b111562b6ee91e90598b183d3ce0`).
[^63]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/gemini-provider.ts:1-21`, `src/gemini-provider.ts:46-100` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^64]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `package.json:1-101` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^65]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/client.ts:19-43`, `src/validation.ts:11-63` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^66]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/client.ts:44-190` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^67]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/gemini-language-model.ts:247-397`, `src/message-mapper.ts:19-210`, `src/tool-mapper.ts:30-230` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^68]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/gemini-language-model.ts:464-481`, `src/message-mapper.ts:140-177` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`); commit `c166ff65c8ee004ed345d65d9630148b3586ac13` message: "feat: add thoughtSignature support for Gemini 3 models (#37)".
[^69]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/gemini-language-model.ts:269-275`, `src/gemini-language-model.ts:398-417`, `src/gemini-language-model.ts:603-620`, `src/message-mapper.ts:183-210`, `src/gemini-language-model.ts:175-209` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^70]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `mix.exs:1-120` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`); Hex package page `https://hex.pm/packages/gemini_cli_sdk` showed version `0.2.0`, license MIT, and package description during research.
[^71]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk.ex:37-49`, `lib/gemini_cli_sdk/stream.ex:1-85` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^72]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk.ex:1-29`, `lib/gemini_cli_sdk.ex:51-164` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^73]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk/options.ex:1-59`, `lib/gemini_cli_sdk/runtime/cli.ex:260-298` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^74]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk/arg_builder.ex:1-88` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^75]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk/runtime/cli.ex:340-352`, `lib/gemini_cli_sdk/types.ex:1-85` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^76]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/package.json:1-36`, `packages/sdk/README.md:6-36` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); `npm view @google/gemini-cli-sdk ...` returned `E404`.
[^77]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/cli/src/config/config.ts:455-461`, `packages/core/src/output/types.ts:9-116`; [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:304-318` (commits `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`, `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^78]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `docs/extensions/writing-extensions.md:13-25`, `docs/extensions/reference.md:104-177`, `docs/extensions/reference.md:213-253` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`).
[^79]: [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/gemini-provider.ts:46-100`, `src/client.ts:98-162`, `src/gemini-language-model.ts:269-397` (commit `c166ff65c8ee004ed345d65d9630148b3586ac13`).
[^80]: [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk.ex:37-60`, `lib/gemini_cli_sdk/stream.ex:52-85`, `lib/gemini_cli_sdk/runtime/cli.ex:230-298` (commit `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
[^81]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/session.ts:80-83`; [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `DESIGN.md:19-20`, `src/agent.ts:91-93`; [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:304-318` (commits `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`, `3cd4aff82c41b111562b6ee91e90598b183d3ce0`, `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^82]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/src/index.ts:7-11`, `packages/sdk/src/session.ts:171-275`, `packages/core/src/output/types.ts:9-116`, `docs/extensions/writing-extensions.md:1-25`; [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) `action.yml:286-368` (commits `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`, `c28f3c6f6e6a537f8fb46e016f65dcfcee381ffa`).
[^83]: [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) `packages/sdk/README.md:6-36`, `packages/sdk/package.json:1-36` (commit `1834ad0298632a52ee27a0f8aca0cc3bc0cfc2c9`); `npm view @google/gemini-cli-sdk ...` returned `E404`.
[^84]: [k2wanko/gemini-cli-sdk](https://github.com/k2wanko/gemini-cli-sdk) `package.json:45-50`; [ben-vargas/ai-sdk-provider-gemini-cli](https://github.com/ben-vargas/ai-sdk-provider-gemini-cli) `src/client.ts:98-162`; [nshkrdotcom/gemini_cli_sdk](https://github.com/nshkrdotcom/gemini_cli_sdk) `lib/gemini_cli_sdk/arg_builder.ex:1-88` (commits `3cd4aff82c41b111562b6ee91e90598b183d3ce0`, `c166ff65c8ee004ed345d65d9630148b3586ac13`, `07d8836ee17f67eebde633aab3cc7b60fcf64ae7`).
