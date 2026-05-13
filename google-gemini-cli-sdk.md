# Google Gemini CLI SDK Research Report

## Executive summary
The most relevant first-party SDK is `@google/gemini-cli-sdk`, a separate programmatic library that sits alongside the Gemini CLI app `@google/gemini-cli` and the broader JavaScript SDK `@google/genai`.[^1][^2] The CLI SDK is session-based and streaming-first: you create a `GeminiCliAgent`, open or resume a session, then consume `sendStream()` results.[^3][^4] It is published as an ESM Node 20+ package with `dist/index.js` and `dist/index.d.ts` entrypoints, and its public barrel re-exports `agent`, `session`, `tool`, `skills`, and `types`.[^1][^3] The docs also warn that advanced features are only partially implemented and that `SessionContext.fs` and `.shell` are powerful trusted-only surfaces.[^4][^5]

## Key repositories

| Repo | Role | Evidence |
|---|---|---|
| `google-gemini/gemini-cli` | Official Gemini CLI monorepo; contains the CLI app and the SDK package. | [^1][^3] |
| `googleapis/js-genai` | Separate general-purpose JS SDK for Gemini/Vertex AI, not the CLI SDK. | [^2] |
| `google-gemini/gemini-skills` | Companion skills library for Gemini API/SDK/model workflows. | [^6] |

## What the CLI SDK is

`@google/gemini-cli-sdk` is the official programmatic interface package, not the terminal binary. Its package metadata shows a library-only ESM package with no CLI bin, a Node 20+ engine requirement, and `dist/` entrypoints for consumers.[^1] The README’s minimal usage path is `npm install @google/gemini-cli-sdk`, `import { GeminiCliAgent }`, create an agent with instructions, and stream results from a session.[^3]

The public surface is intentionally small. The root barrel re-exports the agent/session/tool/skills/type modules, and the main classes/functions are `GeminiCliAgent`, `GeminiCliSession`, `tool()`, and `skillDir()`.[^3][^4] The examples show typed tools with `zod`, plus session context access to `cwd`, `timestamp`, `fs.readFile()`, and `shell.exec()`.[^5]

## Architecture overview

```mermaid
graph TD
  A[App / integrator] --> B[GeminiCliAgent]
  B --> C[GeminiCliSession]
  C --> D[initialize()]
  D --> E[auth / skills / tools]
  C --> F[sendStream()]
  F --> G[streamed model output]
  H[@google/gemini-cli] --> I[terminal CLI app]
  J[@google/genai] --> K[separate JS SDK]
```

The SDK package is a thin orchestration layer over session initialization, authentication, tool registration, and streamed execution.[^4][^5] It is distinct from the Gemini CLI app, which is the terminal executable package, and from `@google/genai`, which is the general Gemini/Vertex JS SDK.[^1][^2]

## Installation and usage

Install the SDK with `npm install @google/gemini-cli-sdk`.[^3] The documented flow is to instantiate `GeminiCliAgent`, then call `session()` and stream the response; the examples show both a simple tool call and a context-aware tool example.[^3][^5]

If you actually want the terminal product, the separate Gemini CLI app is installed and run through `@google/gemini-cli` instead.[^1] That app is the one that exposes the `gemini` command and the broader CLI experience.[^1]

## Caveats and limitations

The design doc says several advanced areas are still incomplete, including hooks, subagents, extensions, ACP, and approval-related features.[^5] It also says dynamic instructions should be sanitized to avoid prompt injection, and it treats `SessionContext.fs` and `SessionContext.shell` as powerful trusted-only capabilities.[^4][^5] One doc inconsistency stands out: the design doc’s overview says skills are missing, but later sections and the runtime implementation indicate skills support is present.[^5]

## Confidence assessment

High confidence: package identity, installation path, public API surface, and the distinction between the CLI app and the SDK are directly verified by package metadata and README/source files.[^1][^3][^4] Medium confidence: feature maturity and roadmap status, because the design doc is internally inconsistent about skills support.[^5] Assumption: the user’s phrase “google gemini cli sdk” refers to the first-party `@google/gemini-cli-sdk` package rather than the broader `@google/genai` SDK.[^1][^2]

## Footnotes

[^1]: `google-gemini/gemini-cli:packages/sdk/package.json:1-36`; `google-gemini/gemini-cli:README.md:9-13`; `google-gemini/gemini-cli:packages/cli/package.json:2-4,12-13,27-30`
[^2]: `googleapis/js-genai:README.md:1-13`
[^3]: `google-gemini/gemini-cli:packages/sdk/README.md:1-35`; `google-gemini/gemini-cli:packages/sdk/src/index.ts:1-11`; `google-gemini/gemini-cli:packages/sdk/src/agent.ts:22-44`
[^4]: `google-gemini/gemini-cli:packages/sdk/src/session.ts:23-63,76-143,145-252`; `google-gemini/gemini-cli:packages/sdk/src/types.ts:21-205`; `google-gemini/gemini-cli:packages/sdk/src/tool.ts:22-64,204-212`
[^5]: `google-gemini/gemini-cli:packages/sdk/examples/simple.ts:6-33`; `google-gemini/gemini-cli:packages/sdk/examples/session-context.ts:6-47`; `google-gemini/gemini-cli:packages/sdk/SDK_DESIGN.md:3-5,41-42,64-65,93-95,109-112,138-170,178-179`
[^6]: `google-gemini/gemini-skills:README.md:1-3,17-27,29-56`
