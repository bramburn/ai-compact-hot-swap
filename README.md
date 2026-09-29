# ai-compact-hot-swap

[![npm version](https://img.shields.io/npm/v/@bramburn/ai-compact-hot-swap?color=cb3837&logo=npm)](https://www.npmjs.com/package/@bramburn/ai-compact-hot-swap)
[![npm downloads](https://img.shields.io/npm/dm/@bramburn/ai-compact-hot-swap?color=cb3837&logo=npm)](https://www.npmjs.com/package/@bramburn/ai-compact-hot-swap)
[![license](https://img.shields.io/npm/l/@bramburn/ai-compact-hot-swap)](LICENSE)

A [pi](https://github.com/earendil-works/pi) coding-agent extension providing a manually-invoked `/hot-swap-compact` command that compacts the session context **in the background** and hot-swaps the live context window when summarization completes.

## Why

pi's built-in `/compact` aborts the in-flight turn and blocks until summarization finishes. `/hot-swap-compact` never interrupts ongoing work:

- **Idle session** — compaction starts immediately in the background via `ctx.compact({ onComplete, onError })`.
- **Busy session** — compaction is queued instead of run, because `AgentSession.compact()` starts with `await this.abort()` and would kill the in-flight turn. Re-invoking the command while one is queued or running just reports the existing state; only one pending compaction is tracked at a time.

### Why queueing is not enough: the looper race

A naive "queue while busy, fire on `turn_end`" guard is still wrong, and the failure is subtle. `ctx.isIdle()` reads `!_isAgentRunActive && !isCompacting`, so a loop extension that schedules its next turn with a timer (pi-goal-x auto-continue, pi-loop, subagent workflows) looks **idle during the gap between turns by construction** — pi-goal-x uses a 50 ms gap. Compact in that gap and the `await this.abort()` inside `ctx.compact()` kills the continuation the *other* extension just queued, surfacing as `This operation was aborted.`

So the extension waits for a genuinely safe window before compacting, requiring all three of:

1. **Session free** — `ctx.isIdle()` *and* `!ctx.hasPendingMessages()`.
2. **Idle stable for 750 ms** — continuously free for longer than any short-gap looper's inter-turn pause, so a gap is never mistaken for "finished". Armed by `turn_end` / `agent_settled`, cleared by `turn_start`.
3. **No external busy guard** — a cross-extension opt-in for long-scheduled work (see below).

A queued compaction polls every 250 ms and starts as soon as all three hold. If nothing frees up within 5 minutes it gives up with a notification and clears state rather than waiting forever. All poll timers are `unref`'d, so a pending queue never holds the host's event loop open.

**The busy-guard registry.** The idle-stability window covers short-gap loopers but cannot tell "finished" from "sleeping for 30 s". Extensions that schedule work on a long timer can publish a guard that deferral honors:

```ts
const KEY = Symbol.for("pi.session.busyGuards");
const registry = ((globalThis as any)[KEY] ??= []) as { id: string; isBusy(): boolean }[];
const guard = { id: "my-extension", isBusy: () => nextRunAt > Date.now() };
registry.push(guard);
// …and remove it on unload
```

Reads are defensive: a missing registry, a non-array, or a throwing `isBusy()` is treated as "no external work scheduled", so this is purely an optimization and can never deadlock compaction. **No extension publishes to this registry yet** — including pi-goal-x, which relies on the idle-stability window alone. The hook is stable and documented so publishers can adopt it without coordinating releases.

When compaction finishes you get a notification (`Hot swap applied: context replaced by summary (backlog through entry N)`), where N is the session entry count captured at trigger time so you know the range of history that was swapped. Failures are notified too, and internal state is cleared.

## Install

### Prerequisites

- [pi](https://github.com/earendil-works/pi) installed (`pi --version`)
- Node.js **≥ 22.19.0** (required by the extension's `engines` field — needed for native TypeScript loading)
- A peer-dep-compatible pi installation (pi bundles `@earendil-works/pi-coding-agent ≥ 0.85.0` automatically)

### From npm (recommended)

The extension is published on npm as **`@bramburn/ai-compact-hot-swap`**.

**Global install** (available in every project):

```sh
pi install npm:@bramburn/ai-compact-hot-swap
```

By default this writes to `~/.pi/agent/settings.json` and installs to `~/.pi/agent/npm/@bramburn/ai-compact-hot-swap`. After install, pi auto-loads the extension on every startup; no reload required for new sessions.

**Project-local install** (recommended for teams / pinned versions):

```sh
pi install npm:@bramburn/ai-compact-hot-swap -l
```

This writes to `<project>/.pi/settings.json` and installs to `<project>/.pi/npm/`. Commit the resulting `.pi/settings.json` entry so teammates auto-install the package when they trust the project. See the [official pi packages docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) for the trust / install-on-startup flow.

**Pin to a specific version:**

```sh
pi install npm:@bramburn/ai-compact-hot-swap@0.1.0
```

Pinned installs are skipped by `pi update --extensions` / `pi update --all` (see [Updates](#updates) below). Use a version range like `@^0.1` to track minor upgrades, or omit the version entirely to always pull the latest.

### Ad-hoc / try-before-install

Run the extension for a single session without persisting it anywhere:

```sh
pi -e npm:@bramburn/ai-compact-hot-swap
# …or against a local checkout:
pi -e /absolute/path/to/ai-compact-hot-swap
```

This installs to a temporary directory and is removed when the session ends. Perfect for evaluating before committing to a global / project install.

### Manual install (legacy / dev)

Copy or symlink this directory into one of:

- `~/.pi/agent/extensions/ai-compact-hot-swap` (available in every project), or
- `<project>/.pi/extensions/ai-compact-hot-swap` (project-local)

This bypasses the `pi install` machinery entirely. Useful when developing the extension locally — symlink so your edits are picked up on `/reload`.

### Verify the install

After installing, start pi and look for the extension in the startup header, or run:

```sh
pi list            # shows installed packages and their versions
pi config          # toggle the extension on/off interactively
```

The command registers as `/hot-swap-compact` — type `/` in the editor to see it in the slash menu.

### Uninstall

```sh
pi remove npm:@bramburn/ai-compact-hot-swap
```

For project-local installs add `-l`. For manual installs, just delete the copied / symlinked directory.

## Usage

```
/hot-swap-compact [optional custom instructions]
```

Any trailing text is forwarded to `ctx.compact({ customInstructions })` to steer the summarizer prompt.

## Custom summarizer (optional)

By default, `/hot-swap-compact` is just a non-blocking wrapper around pi's normal compaction pipeline — which itself honors pi's built-in `PI_SUMMARIZER_BASE_URL` / `PI_SUMMARIZER_MODEL` / `PI_SUMMARIZER_API_KEY` env overrides. The extension does nothing extra.

If you want the summarization step to use a **different model** than the one running the session — a cheaper model, a local model for privacy, or a model with better summarization quality — the extension can register a separate OpenAI-compatible endpoint as a custom summarizer via the env vars below. This feature is fully opt-in.

### Required env vars (all three must be set together)

| Env var | Meaning |
| --- | --- |
| `PI_HOTSWAP_SUMMARIZER_BASE_URL` | Base URL of the OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama, your private proxy URL) |
| `PI_HOTSWAP_SUMMARIZER_API_KEY` | Bearer token the endpoint expects. Use any non-empty string for endpoints that ignore auth (Ollama, most local servers). The literal string is passed through; the extension does not validate it. |
| `PI_HOTSWAP_SUMMARIZER_MODEL` | Model id the endpoint should use for summarization (e.g. `gpt-4o-mini`, `llama3.1:8b`, `qwen2.5:14b`) |

The three must be set **as a group** — see "Partial configuration" below for the exact behavior when one or two are missing.

### Optional env vars

| Env var | Meaning |
| --- | --- |
| `PI_HOTSWAP_SUMMARIZER_PROVIDER` | Internal id used to register the summarizer with pi's provider registry. Defaults to `hotswap-summarizer`. You only need to override this if the default id collides with another provider you've registered elsewhere — either via `~/.pi/agent/models.json` or another extension. If you see a `provider already registered` error in the logs, set this to a unique value like `bramburn-hotswap-summarizer` to disambiguate. |
| `PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW` | Positive integer telling the extension the summarizer's **real** context window in tokens (e.g. `128000`). Used to size batches for chunked summarization. When unset, the extension probes `${BASE_URL}/models` (and `/v1/models`) once per session for a `context_window` / `max_context_length` / `max_input_tokens` field; on miss it falls back to a conservative `128_000` default. Non-numeric values produce a stderr warning and fall through to the probe. |

### What happens at runtime

When **all three required vars are set**, the extension registers your endpoint with pi's provider/model registry the first time a compaction fires in the session, then intercepts every subsequent `session_before_compact` event:

1. **Register the provider** (first compaction only). Calls `pi.registerProvider(providerId, { ... })` with a single model entry pointing at your endpoint. A closure flag (`providerRegistered`) guards against re-registering on later compactions — without it, the second compaction in the same session would throw a duplicate-registration error.
2. **Handle `session_before_compact`**. pi fires this event before **every** compaction in the session — manual `/compact`, threshold-based auto-compaction, context-overflow recovery, and our `/hot-swap-compact` all route through it. The extension:
 - Builds a summarization prompt from the conversation history (including the previous summary, if any).
 - Calls your endpoint via `ctx.modelRegistry.complete(...)` with `maxTokens: 8192` and `cacheRetention: "none"` (summaries aren't reused across sessions).
 - Returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }` to pi. This is the same shape pi's built-in summarizer returns, so pi applies the result to the session exactly as if it had summarized itself — the backlog is replaced by the summary, kept entries are preserved, and the session continues with the new context.

If the registered model can't be found, returns an empty summary, or throws, the extension emits a notification (`Hot-swap summarizer model not found`, `Hot-swap summary was empty`, or `Hot-swap summarization failed: ...`) and returns `undefined`. pi then falls back to its default summarization and the compaction still completes.

### Handling summarizers smaller than the conversation (chunking)

The registered model advertises `contextWindow: 1_000_000` to pi so pi doesn't pre-truncate the conversation it hands the extension. **That advertised value is not what the summarizer actually has** — most endpoints cap out well below 1M (Ollama defaults to 2048, llama3.1:8b to 128k, etc.). When the conversation exceeds the real window, the extension's chunking path kicks in:

1. **Resolve the real window** in this order: `PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW` → probe `${BASE_URL}/models` for a `context_window` / `max_context_length` / `max_input_tokens` field → `128_000` fallback. The probe result is cached for the session.
2. **Estimate** the serialized conversation size with a conservative chars/4 heuristic.
3. **Single-shot** when the estimate fits in `(realWindow - 16384 reserve - 4000 prompt overhead)` — no overhead added.
4. **Otherwise chunk**: split the messages into batches that fit the budget, never splitting a single message across batches. Summarize each batch sequentially, threading the previous summary's text into the next batch's prompt as `previousSummary`. Cap the previous summary at ~8K tokens to keep each subsequent prompt within budget. A user notification (`Hot-swap summarizer: chunked summary N/M...`) fires for each batch.
5. **Catch-overflow retry**: if the upstream still rejects with a context-overflow error (estimate was off, or the endpoint has a smaller window than advertised), the extension re-chunks with **half the batch budget** and retries once. If the retry also fails, it falls back to pi's default summarizer with a warning.

The rolling-summary approach is intentional: each batch sees both the previous summary and its own slice of the conversation, so the final output captures the full history. The summarizer's instruction text explicitly tells it to "build on the previous summary — preserve its conclusions and add only the new information from this batch."

You should set `PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW` whenever you know the true value (always — it's free and the cheapest source in the chain). The endpoint probe covers providers that publish the field (OpenRouter, vLLM, Ollama with `--verbose`, etc.); for everything else the 128K fallback is conservative enough that most summarization requests succeed without retry.

### Partial configuration

If you set **one or two** of the required vars but leave the others unset (typo, half-exported shell, forgot to set `PI_HOTSWAP_SUMMARIZER_API_KEY`), the extension detects the partial set on startup and prints a warning to stderr naming the missing vars:

```
[hot-swap-compact] PI_HOTSWAP_SUMMARIZER_* override is incomplete
(missing: PI_HOTSWAP_SUMMARIZER_API_KEY). Falling back to the
session's current model for compaction.
```

The custom summarizer is **disabled for the whole session** — every compaction (including `/hot-swap-compact`) routes through pi's normal path using the session's current model. The contract is intentionally **all-or-nothing**: partial configurations are treated as misconfigurations, never as opt-ins for some-but-not-all compactions.

This mirrors pi's own `PI_SUMMARIZER_*` env vars (same three names, same "set all three or none" semantics) so the two override knobs feel consistent.

### No env vars set

The extension is a no-op. `/hot-swap-compact` calls `ctx.compact(...)` exactly like pi's built-in `/compact`, except non-blocking.

### Scope: this affects every compaction in the session

Because the handler is wired to `session_before_compact` (not just `/hot-swap-compact`), the custom summarizer handles **all** compactions in the session once the env vars are set:

- `/hot-swap-compact` (this extension)
- The built-in `/compact` command
- Threshold-based auto-compaction (pi's setting that compacts when context grows)
- Context-overflow recovery (when a request would exceed the model's window)

Unset the env vars and start a new session to restore pi's default summarization everywhere.

### Model defaults

The registered model advertises `contextWindow: 1_000_000` and `maxTokens: 8192` to pi. These are budgeting hints for pi, not hard limits enforced against your endpoint:

- `maxTokens` caps the length of the summary your endpoint is allowed to return.
- `contextWindow` is intentionally large so pi doesn't pre-truncate the conversation it hands the extension. The actual chunking budget comes from `PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW` (or the endpoint probe, or the 128K fallback) — see "Handling summarizers smaller than the conversation (chunking)" above.

## Edge cases

- **Compaction failure** — notified via `ui.notify` with level `error`; queued/running state is cleared.
- **Extension reloaded mid-compaction** — all state lives in the extension instance, so a reload loses the pending flag and the in-flight compaction's completion callback. The session is unaffected (compaction still completes server-side); only the notification is lost.
- **No UI** — notifications are skipped when running headless (`ctx.hasUI` guard), except the partial-env warning which also goes to `console.warn`.
- **Summarizer endpoint probe fails** — cached as `probed-missing` so the extension doesn't repeatedly hit a flaky endpoint; subsequent compactions use the 128K fallback window.
- **Catch-overflow retry also fails** — falls back to pi's default summarizer with a `warning` notification. The compaction still completes; you just don't get the cost/speed benefits of the custom summarizer for that one call.

## Updates

### Update all packages

```sh
pi update --extensions   # update packages + reconcile pinned git refs
pi update --all          # update pi itself too + packages + git refs
```

Both commands walk your installed packages and pull the latest matching version from their source. **Scoped / pinned installs are skipped by default** — see below.

### Update this package only

```sh
pi update npm:@bramburn/ai-compact-hot-swap
# …or the long form:
pi update --extension npm:@bramburn/ai-compact-hot-swap
```

### Update to a specific version

Re-install with the version you want:

```sh
pi install npm:@bramburn/ai-compact-hot-swap@0.2.0
```

This rewrites the entry in your settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`) with the new pin.

### Revert to an older version

Same as above — install the older version:

```sh
pi install npm:@bramburn/ai-compact-hot-swap@0.1.0
```

### Pinned installs are not auto-updated

If you installed with an explicit version (`@1.2.3` or `@^1.2`), `pi update --extensions` will **not** move the pin. This is intentional — versioned specs are treated as user commitments. To move a pinned package, run `pi install` again with the new version (or no version, to pick up the latest).

For automatic upgrades, install without a version: `pi install npm:@bramburn/ai-compact-hot-swap` (always tracks `latest`) or with a minor-range: `npm:@bramburn/ai-compact-hot-swap@^0.1` (tracks the latest `0.x.x`).

### Refresh model catalogs only

```sh
pi update --models
```

This refreshes the model registry without touching package versions. Useful after a new model is published by your provider.

## Contribution

The repo is at **<https://github.com/bramburn/ai-compact-hot-swap>**. Issues and PRs welcome.

### Local development

Clone and install:

```sh
git clone https://github.com/bramburn/ai-compact-hot-swap.git
cd ai-compact-hot-swap
npm install
```

The repo pins `@typescript/native-preview` (the `tsgo` binary) as a devDependency so `npm run typecheck` works without any global toolchain.

Run the extension from your working copy without publishing:

```sh
# Either symlink into pi's extensions dir:
ln -s "$(pwd)" ~/.pi/agent/extensions/ai-compact-hot-swap

# …or run ad-hoc for one session:
pi -e "$(pwd)/index.ts"
```

Symlinking picks up live edits on the next `/reload` in pi; ad-hoc runs use the on-disk file directly.

### Project structure

```
.
├── index.ts
├── package.json
├── tsconfig.json
├── .npmignore
├── README.md
└── LICENSE
```

Where:

- `index.ts` — the extension; the only file shipped to npm
- `package.json` — npm metadata + the `pi.extensions` manifest that tells pi what to load
- `tsconfig.json` — typecheck config (dev-only; not shipped)
- `.npmignore` — whitelist for the npm tarball
- `README.md` — this file
- `LICENSE` — MIT


The extension is a single TypeScript file. The npm tarball publishes exactly 4 files (LICENSE, README.md, index.ts, package.json). No build step — pi loads `index.ts` directly via Node's TypeScript stripping (≥ 22.19).

### Code conventions

- **Single default export** — `export default function (pi: ExtensionAPI)` registered by pi's extension loader.
- **No top-level side effects** — keep all state inside the factory closure so each session gets its own instance.
- **Strict TypeScript** — `strict: true`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. The file must compile cleanly without emitting JS.
- **Use the `pi` SDK only via `@earendil-works/pi-coding-agent`** — declared in `peerDependencies` (not bundled).
- **Notifications** — prefer `ctx.ui.notify(level, message)` over `console.log` so headless runs stay quiet. Fall back to `console.warn` only for warnings the user must see regardless of UI state.

### Typecheck & test

```sh
npm run typecheck    # tsgo --noEmit -p tsconfig.json
npm test             # node scripts/smoke.mjs - 34 checks, 10 scenarios
```

The bundled `tsconfig.json` maps `@earendil-works/pi-coding-agent` to a local pi checkout for types — adjust the `paths` entry (or remove it and rely on the installed peer dep) if your layout differs.

#### Automated smoke suite

`scripts/smoke.mjs` runs one child process per scenario, because `index.ts` reads `process.env` at module-load time and a fresh module cache per scenario is the only way to test env-dependent registration. Each child imports the **real** `index.ts`, drives the real `session_before_compact` handler with a real `AbortController`, and stands up an actual `node:http` server for the endpoint-probe scenario - so the assertions exercise shipping code, not a mock of it.

| Scenario | What it pins down |
| --- | --- |
| 1-2 | Handler is **not** registered with no env vars / partial env; the partial case warns on stderr naming the missing var |
| 3 | Single-shot path for a small conversation; advertised `contextWindow` is 1 000 000 |
| 4, 8 | Chunking fires when the conversation exceeds the resolved window (>1 `complete()` call) |
| 5 | A real `context_length_exceeded` throw triggers the half-budget retry and still returns a summary |
| 6 | A non-numeric `PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW` warns and falls through to the probe |
| 7 | A working probe supplies the window - asserts the probed **65536**, not the 128 000 fallback, so the test cannot pass by coincidence |
| 9 | Regression: goal-mode's 50 ms inter-turn gap must **not** compact (`compactCalls === 0`) |
| 10 | A genuinely stable-idle session **does** compact, once the 750 ms window matures |

Scenario 9 is the one that matters most. An earlier version of the poll loop left the re-armed timer referenced, so a queued compaction held the event loop open and that scenario never exited - the suite hung rather than failing. Keep `unref()` on **every** arm point; the suite only terminates if it is there.

One assertion is verified by code reading rather than by a scenario: that a valid env hint takes precedence over a *working* probe. It is a one-line early return in `resolveSummarizerWindow()`, and both halves of it (env to probe, probe to used) are covered above.

#### Manual end-to-end check

Also worth doing before a release: install the published version into a throwaway project and confirm the extension loads:

```sh
mkdir /tmp/pi-smoke && cd /tmp/pi-smoke
npm init -y >/dev/null
npm install @bramburn/ai-compact-hot-swap@latest
pi -e ./node_modules/@bramburn/ai-compact-hot-swap/index.ts
```

In the session, type `/hot-swap-compact` and confirm the command appears in the slash menu.

### Submitting changes

1. Fork the repo.
2. Create a topic branch: `git checkout -b fix/your-bug` or `feat/your-feature`.
3. Make your change. Run `npm run typecheck && npm test` until both are clean.
4. Commit with a descriptive message. If your change is user-visible, mention it in the PR description.
5. Open a PR against `main`. CI (if you set it up) will re-run the typecheck and the smoke suite.

### Release process

Maintainer-only — the package is published from this repo by `@bramburn`.

1. Bump `version` in `package.json` (semver: `patch` for fixes, `minor` for new features, `major` for breaking changes).
2. Update `README.md` if the user-facing surface changed (new env vars, new commands, behavior changes).
3. Run `npm run typecheck` to make sure `prepublishOnly` will pass.
4. Commit the version bump: `git commit -am "release: v0.x.y"`.
5. `git tag v0.x.y && git push --tags` (optional — the tag isn't strictly needed since npm carries its own version, but it helps the GitHub release page).
6. Publish:

   ```sh
   npm publish --access public
   ```

   npm will prompt for an OTP if the npm account has 2FA enabled (recommended). Pass it directly to skip the interactive prompt:

   ```sh
   npm publish --access public --otp=<code>
   ```

7. Verify:

   ```sh
   npm view @bramburn/ai-compact-hot-swap version
   curl -sH "Accept: application/json" https://registry.npmjs.org/@bramburn/ai-compact-hot-swap | head
   ```

   Should report `0.x.y` and a JSON object (the CDN may return 404 to non-JSON Accept headers due to a Cloudflare quirk — use the explicit `Accept: application/json` header).

8. Create the GitHub release at <https://github.com/bramburn/ai-compact-hot-swap/releases> with the tag from step 5 and a short changelog.

## License

[MIT](LICENSE) © 2026 bramburn
