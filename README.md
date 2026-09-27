# ai-compact-hot-swap

A [pi](https://github.com/earendil-works/pi) coding-agent extension providing a manually-invoked `/hot-swap-compact` command that compacts the session context **in the background** and hot-swaps the live context window when summarization completes.

## Why

pi's built-in `/compact` aborts the in-flight turn and blocks until summarization finishes. `/hot-swap-compact` never interrupts ongoing work:

- **Idle session** — compaction starts immediately in the background via `ctx.compact({ onComplete, onError })`.
- **Busy session (turn in flight)** — compaction is queued instead of run, because `AgentSession.compact()` would abort the running turn. The queued compaction fires automatically on the next `turn_end` event. Re-invoking the command while one is queued or running just reports the existing state; only one pending compaction is tracked at a time.

When compaction finishes you get a notification (`Hot swap applied: context replaced by summary (backlog through entry N)`), where N is the session entry count captured at trigger time so you know the range of history that was swapped. Failures are notified too, and internal state is cleared.

## Install

Copy or symlink this directory into either:

- `~/.pi/agent/extensions/ai-compact-hot-swap` (available in every project), or
- `<project>/.pi/extensions/ai-compact-hot-swap` (project-local)

Or run it ad-hoc for one session:

```sh
pi -e /path/to/ai-compact-hot-swap/index.ts
```

## Usage

```
/hot-swap-compact [optional custom instructions]
```

Any trailing text is forwarded to `ctx.compact({ customInstructions })` to steer the summarizer prompt.

## Custom summarizer (optional)

By default the extension does nothing special and pi's normal compaction runs — which itself honors pi's `PI_SUMMARIZER_BASE_URL` / `PI_SUMMARIZER_MODEL` / `PI_SUMMARIZER_API_KEY` env override.

To route hot-swap summarization through a separate OpenAI-compatible endpoint instead, set **all three** of:

| Env var | Meaning |
| --- | --- |
| `PI_HOTSWAP_SUMMARIZER_BASE_URL` | Base URL of an OpenAI-compatible endpoint |
| `PI_HOTSWAP_SUMMARIZER_API_KEY` | API key for that endpoint |
| `PI_HOTSWAP_SUMMARIZER_MODEL` | Model id to summarize with |

Optional:

| Env var | Meaning |
| --- | --- |
| `PI_HOTSWAP_SUMMARIZER_PROVIDER` | Provider id label used for registration (default `hotswap-summarizer`) |

If only some of the three required vars are set, the extension warns and falls back to the session's current model — mirroring pi's `PI_SUMMARIZER_*` contract. When all three are set, the extension registers a provider (guarded against duplicate registration) and performs the summarization itself via `session_before_compact`, returning `{ compaction }` so pi applies the result exactly like a normal compaction.

Note: once the `PI_HOTSWAP_SUMMARIZER_*` env vars are set, the custom summarizer handles **all** compactions in the session — not just `/hot-swap-compact`. That includes the built-in `/compact` command, threshold-based auto-compaction, and context-overflow recovery. Unset the env vars (or run without them) to restore pi's default summarization everywhere.

The registered model uses hardcoded defaults of `contextWindow: 1_000_000` and `maxTokens: 8192`. These only need to be accurate enough for pi's request budgeting: `maxTokens` caps the summary length the endpoint will return, and `contextWindow` should be at least as large as the conversation you expect to summarize (pi does not chunk the prompt for extension-provided summarizations, so if the real endpoint model has a smaller window, a very long session can overflow it). If your endpoint's real limits are much lower, reduce `contextWindow` accordingly.

## Edge cases

- **Compaction failure** — notified via `ui.notify` with level `error`; queued/running state is cleared.
- **Extension reloaded mid-compaction** — all state lives in the extension instance, so a reload loses the pending flag and the in-flight compaction's completion callback. The session is unaffected (compaction still completes server-side); only the notification is lost.
- **No UI** — notifications are skipped when running headless (`ctx.hasUI` guard), except the partial-env warning which also goes to `console.warn`.

## Typecheck

```sh
npx tsgo --noEmit -p tsconfig.json
```

(The tsconfig maps `@earendil-works/pi-coding-agent` to a local pi checkout for types; adjust the path or install the package if your layout differs.)
