/**
 * ai-compact-hot-swap
 *
 * Manually-invoked `/hot-swap-compact` command that compacts the session
 * context in the BACKGROUND (non-blocking) and hot-swaps the live context
 * window when summarization completes — unlike pi's built-in `/compact`,
 * which aborts the in-flight turn and blocks.
 *
 * Optional custom summarizer via env vars (all three required, mirroring
 * pi's PI_SUMMARIZER_* contract but with a PI_HOTSWAP_SUMMARIZER_* prefix):
 * PI_HOTSWAP_SUMMARIZER_BASE_URL OpenAI-compatible endpoint
 * PI_HOTSWAP_SUMMARIZER_API_KEY API key for that endpoint
 * PI_HOTSWAP_SUMMARIZER_MODEL model id to summarize with
 * PI_HOTSWAP_SUMMARIZER_PROVIDER optional provider id label
 * (default "hotswap-summarizer")
 *
 * Optional context-window hint (so the chunking path knows the summarizer's
 * REAL window — the registered model advertises 1_000_000 so pi doesn't
 * pre-truncate):
 * PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW positive integer (e.g. 128000). When
 * unset, the extension probes ${BASE_URL}/models for a context_window field
 * on first use (cached). When neither is available, it falls back to a
 * conservative 128_000 default.
 *
 * Optional idle-stability tuning (read regardless of the summarizer vars):
 * PI_HOTSWAP_SUMMARIZER_IDLE_MS non-negative integer; how long the session
 * must look continuously idle before a queued compaction fires
 * (default 750 ms).
 *
 * Install: copy or symlink this directory into ~/.pi/agent/extensions or a
 * project's .pi/extensions, or run ad-hoc with `pi -e path/to/index.ts`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/** The message array type accepted by convertToLlm (inferred; AgentMessage
 * lives in pi-agent-core which isn't a direct peer dep). */
type MessagesToSummarize = Parameters<typeof convertToLlm>[0];
/** The Model type accepted by modelRegistry.complete (inferred). */
type SummarizerModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

const BASE_URL_ENV = "PI_HOTSWAP_SUMMARIZER_BASE_URL";
const API_KEY_ENV = "PI_HOTSWAP_SUMMARIZER_API_KEY";
const MODEL_ENV = "PI_HOTSWAP_SUMMARIZER_MODEL";
const PROVIDER_ENV = "PI_HOTSWAP_SUMMARIZER_PROVIDER";
const CONTEXT_WINDOW_ENV = "PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW";

const DEFAULT_PROVIDER_ID = "hotswap-summarizer";

/**
 * Token budgeting for chunked summarization.
 *
 * - RESERVE_TOKENS: leaves room for the summarizer's own prompt overhead +
 *   response. Matches pi's internal reserve of 16_384 used by its default
 *   summarizer, so chunked calls land in the same ballpark.
 * - PROMPT_OVERHEAD_TOKENS: estimated size of our own instructions +
 *   conversation wrapper + previous-summary wrapper. Conservative estimate
 *   so we never overflow.
 * - PREVIOUS_SUMMARY_CAP_TOKENS: hard cap on the rolling-summary text fed
 *   into each subsequent batch. Keeps the per-batch prompt from growing
 *   unboundedly if the summarizer is verbose.
 * - FALLBACK_CONTEXT_WINDOW: last-resort window size when neither env var
 *   nor /models probe yields a usable number. 128k matches a Llama-3-class
 *   open-source model — conservative enough to fit most local endpoints.
 */
const RESERVE_TOKENS = 16_384;
const PROMPT_OVERHEAD_TOKENS = 4_000;
const PREVIOUS_SUMMARY_CAP_TOKENS = 8_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * How often to re-check whether the session has become safe to compact
 * while a queued compaction waits. 250ms keeps the wait imperceptible
 * without spinning the event loop.
 */
const SAFE_TO_COMPACT_POLL_MS = 250;

const IDLE_STABILITY_ENV = "PI_HOTSWAP_SUMMARIZER_IDLE_MS";

/**
 * How long the session must look continuously idle before we treat it as
 * genuinely finished.
 *
 * `ctx.isIdle()` alone is NOT enough: it reads `!_isAgentRunActive &&
 * !isCompacting`, and long-running loop extensions (pi-goal-x auto-continue,
 * pi-loop, subagent workflows) schedule their next turn with a timer
 * *between* turns. The session is idle during that gap by construction —
 * pi-goal-x uses a 50ms gap. `ctx.compact()` starts with
 * `await this.abort()`, so compacting in the gap kills the continuation the
 * other extension just queued ("This operation was aborted.").
 *
 * Requiring a continuous idle window longer than the largest inter-turn gap
 * makes that race unreachable for short-gap loopers without any coupling to
 * a specific peer extension.
 *
 * Overridable via PI_HOTSWAP_SUMMARIZER_IDLE_MS — raise it above your
 * looper's inter-turn gap if compactions keep aborting turns; see
 * resolveIdleStabilityMs.
 */
const DEFAULT_IDLE_STABILITY_MS = 750;

/**
 * Upper bound on how long a queued compaction waits for a safe window
 * before giving up and telling the user.
 */
const SAFE_TO_COMPACT_TIMEOUT_MS = 5 * 60_000;

/**
 * Cross-extension "I'm about to schedule work" registry.
 *
 * The idle-stability window covers loopers with short inter-turn gaps. It
 * cannot distinguish "finished" from "sleeping for 30s", so extensions that
 * schedule work on a long timer can publish a guard here and have us defer
 * until they report idle again.
 *
 * Contract: push `{ id: string; isBusy(): boolean }` onto
 * `globalThis[Symbol.for("pi.session.busyGuards")]`. Reads are defensive —
 * a missing registry, a non-array, or a throwing `isBusy()` is treated as
 * "no external work scheduled" so this stays a pure optimization and can
 * never deadlock compaction.
 */
const BUSY_GUARDS_KEY = Symbol.for("pi.session.busyGuards");

interface BusyGuard {
	id: string;
	isBusy(): boolean;
}

/** Returns the id of an extension reporting scheduled work, or null. */
function findExternalBusyGuard(): string | null {
	try {
		const registry = (globalThis as Record<symbol, unknown>)[BUSY_GUARDS_KEY];
		if (!Array.isArray(registry)) return null;
		for (const guard of registry as BusyGuard[]) {
			if (guard && typeof guard.isBusy === "function" && guard.isBusy()) {
				return typeof guard.id === "string" ? guard.id : "unknown";
			}
		}
	} catch {
		// Never let a misbehaving guard block compaction.
	}
	return null;
}

/** Heuristic token count: chars / 4, rounded up. Intentionally conservative. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

interface HotswapSummarizerEnv {
	baseUrl: string;
	apiKey: string;
	model: string;
	providerId: string;
	/** Optional context-window hint from PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW */
	contextWindowHint?: number;
}

function resolveSummarizerEnv(): HotswapSummarizerEnv | undefined | "partial" {
	const baseUrl = process.env[BASE_URL_ENV]?.trim();
	const apiKey = process.env[API_KEY_ENV]?.trim();
	const model = process.env[MODEL_ENV]?.trim();
	const providerId = process.env[PROVIDER_ENV]?.trim() || DEFAULT_PROVIDER_ID;

	if (!baseUrl && !apiKey && !model) return undefined;
	if (!baseUrl || !apiKey || !model) {
		const missing = [
			!baseUrl && BASE_URL_ENV,
			!apiKey && API_KEY_ENV,
			!model && MODEL_ENV,
		].filter((name): name is string => !!name);
		console.warn(
			`[hot-swap-compact] PI_HOTSWAP_SUMMARIZER_* override is incomplete ` +
				`(missing: ${missing.join(", ")}). Falling back to the session's current model for compaction.`,
		);
		return "partial";
	}

	let contextWindowHint: number | undefined;
	const rawWindow = process.env[CONTEXT_WINDOW_ENV]?.trim();
	if (rawWindow) {
		const parsed = Number.parseInt(rawWindow, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			contextWindowHint = parsed;
		} else {
			console.warn(
				`[hot-swap-compact] ${CONTEXT_WINDOW_ENV}=${JSON.stringify(rawWindow)} ` +
					`is not a positive integer; falling back to endpoint probe.`,
			);
		}
	}

	return { baseUrl, apiKey, model, providerId, contextWindowHint };
}

/**
 * Parses the optional idle-stability override.
 *
 * Unlike the summarizer vars this is NOT all-or-nothing and applies whether
 * or not PI_HOTSWAP_SUMMARIZER_* is set — it tunes the trigger gating, not
 * the summarizer. Non-numeric values warn on stderr and fall back to the
 * default so a typo degrades to known behavior instead of disabling the
 * guard.
 */
function resolveIdleStabilityMs(): number {
	const raw = process.env[IDLE_STABILITY_ENV]?.trim();
	if (!raw) return DEFAULT_IDLE_STABILITY_MS;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	console.warn(
		`[hot-swap-compact] ${IDLE_STABILITY_ENV}=${JSON.stringify(raw)} ` +
			`is not a non-negative integer; using the default ${DEFAULT_IDLE_STABILITY_MS} ms.`,
	);
	return DEFAULT_IDLE_STABILITY_MS;
}

/**
 * Probes the configured endpoint for a real context_window for the model.
 *
 * Tries two paths (no-version + /v1) because endpoints differ on whether
 * they expect the version prefix. Tries the OpenAI-style field names that
 * real providers actually use (`context_window`, `max_context_length`,
 * `max_input_tokens`, etc.) and falls through silently on any failure so
 * we never block compaction on a flaky probe.
 *
 * Returns undefined when no window can be determined; callers then fall
 * back to FALLBACK_CONTEXT_WINDOW.
 */
async function probeContextWindow(baseUrl: string, apiKey: string, model: string): Promise<number | undefined> {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const candidates = [`${trimmed}/models`, `${trimmed}/v1/models`];
	const fieldNames = [
		"context_window",
		"contextWindow",
		"max_context_length",
		"maxContextLength",
		"max_input_tokens",
		"maxInputTokens",
		"max_tokens",
		"maxTokens",
	];
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	for (const url of candidates) {
		try {
			const response = await fetch(url, { headers });
			if (!response.ok) continue;
			const json = (await response.json()) as { data?: Array<Record<string, unknown>> };
			const entries = Array.isArray(json.data) ? json.data : [];
			// Match by id (case-insensitive) — some providers uppercase, some lowercase.
			const target = model.toLowerCase();
			const entry = entries.find((e) => typeof e.id === "string" && e.id.toLowerCase() === target);
			if (!entry) continue;
			for (const field of fieldNames) {
				const value = entry[field];
				if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
					return value;
				}
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Detects context-overflow errors from arbitrary OpenAI-compatible providers.
 *
 * The wording varies wildly across vendors (OpenAI, Anthropic via gateway,
 * Ollama, vLLM, OpenRouter), so we match a small set of phrases rather than
 * a single string. The check is intentionally lenient: false positives
 * trigger the chunking path, which is strictly safer than not chunking.
 */
function isContextOverflowError(error: unknown): boolean {
	if (!error) return false;
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	return (
		lower.includes("context_length_exceeded") ||
		lower.includes("context length exceeded") ||
		lower.includes("context_overflow") ||
		lower.includes("maximum context length") ||
		lower.includes("reduce the length") ||
		lower.includes("too many tokens") ||
		lower.includes("string too long") ||
		lower.includes("context window") ||
		lower.includes("maximum token limit") ||
		lower.includes("prompt is too long") ||
		lower.includes("input is too long")
	);
}

/**
 * Splits messages into batches where each batch's serialized conversation
 * fits within `maxBatchTokens`. Never splits a single message — if a
 * message is itself larger than the budget, it goes alone in a batch
 * (and the caller will likely see an overflow error, which the catch
 * path handles by re-chunking from a smaller batch).
 */
function chunkMessages(messages: MessagesToSummarize, maxBatchTokens: number): MessagesToSummarize[] {
	if (messages.length === 0) return [];
	const batches: MessagesToSummarize[] = [];
	let current: MessagesToSummarize = [];
	let currentTokens = 0;
	for (const m of messages) {
		const tokens = estimateTokens(serializeConversation(convertToLlm([m])));
		if (current.length > 0 && currentTokens + tokens > maxBatchTokens) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(m);
		currentTokens += tokens;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * Truncates `text` to `maxTokens` tokens worth of characters, breaking at
 * the nearest sentence/paragraph boundary. Returns a marker so the
 * summarizer knows the input was truncated (helps it skip less-important
 * trailing context).
 */
function capSummaryLength(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	const slice = text.slice(0, maxChars);
	// Find a sensible break point (newline near the cap).
	const lastBreak = slice.lastIndexOf("\n\n");
	const trimmed = lastBreak > maxChars * 0.7 ? slice.slice(0, lastBreak) : slice;
	return `${trimmed}\n\n[…previous summary truncated for length…]`;
}

type Notify = (message: string, level: "info" | "warning" | "error") => void;

export default function (pi: ExtensionAPI) {
	// --- state -------------------------------------------------------------
	let pending = false;
	let pendingInstructions: string | undefined;
	let compacting = false;
	let providerRegistered = false;
	// Entry count captured at trigger time so the completion notice can tell
	// the user the backlog range that was swapped.
	let triggerEntryCount: number | undefined;
	// Timer handle for a queued compaction polling for a safe-to-compact
	// window. Cleared when the compaction starts, completes, or errors.
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	// Timestamp of when the session last transitioned to idle. Undefined
	// whenever a turn is running. Drives the idle-stability window.
	let idleSince: number | undefined;

	const summarizerEnv = resolveSummarizerEnv();
	const idleStabilityMs = resolveIdleStabilityMs();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const clearWaitTimer = () => {
		if (waitTimer !== undefined) {
			clearTimeout(waitTimer);
			waitTimer = undefined;
		}
	};

	/**
	 * Whether the session is momentarily free of work: no active run and
	 * nothing already queued for delivery.
	 */
	const isSessionFree = (ctx: ExtensionContext): boolean => {
		try {
			if (!ctx.isIdle()) return false;
			if (ctx.hasPendingMessages()) return false;
			return true;
		} catch {
			// A host that does not implement one of these: fall back to the
			// historical isIdle()-only behavior rather than blocking forever.
			try {
				return ctx.isIdle();
			} catch {
				return false;
			}
		}
	};

	/**
	 * Whether it is safe to call `ctx.compact()` right now.
	 *
	 * Requires three things, because none alone is sufficient:
	 * 1. the session is free of in-flight and queued work (`isSessionFree`),
	 * 2. it has looked free continuously for `idleStabilityMs`, so a
	 *    looper's short inter-turn gap is not mistaken for "finished", and
	 * 3. no extension has published a long-scheduled-work guard.
	 */
	const isSafeToCompact = (ctx: ExtensionContext): boolean => {
		if (!isSessionFree(ctx)) return false;
		if (findExternalBusyGuard()) return false;
		if (idleSince === undefined) return false;
		return Date.now() - idleSince >= idleStabilityMs;
	};

	/** Recompute the idle-since marker; call whenever session state may change. */
	const markIdleState = (ctx: ExtensionContext) => {
		idleSince = isSessionFree(ctx) ? (idleSince ?? Date.now()) : undefined;
	};

	const runCompaction = (ctx: ExtensionContext, customInstructions?: string) => {
		// Final gate, as close to ctx.compact() as possible. The scheduled call
		// path already verified isSafeToCompact, but a looper can start its next
		// turn in the gap between that check and compact()'s internal
		// `await this.abort()` — which would kill the just-started turn
		// ("This operation was aborted"). If the window closed again, silently
		// re-queue and let the poll loop take the next genuinely safe window.
		// This shrinks the race; only a busy-guard publisher can eliminate it.
		if (!isSafeToCompact(ctx)) {
			queueCompaction(ctx, customInstructions, { silent: true });
			return;
		}
		compacting = true;
		clearWaitTimer();
		try {
			triggerEntryCount = ctx.sessionManager.getEntries().length;
		} catch {
			triggerEntryCount = undefined;
		}
		notify(ctx, `Hot-swap compaction started in background (entry ${triggerEntryCount ?? "?"})...`, "info");
		ctx.compact({
			customInstructions,
			onComplete: () => {
				compacting = false;
				pending = false;
				pendingInstructions = undefined;
				clearWaitTimer();
				notify(
					ctx,
					triggerEntryCount !== undefined
						? `Hot swap applied: context replaced by summary (backlog through entry ${triggerEntryCount}).`
						: "Hot swap applied: context replaced by summary.",
					"info",
				);
			},
			onError: (error) => {
				compacting = false;
				pending = false;
				pendingInstructions = undefined;
				clearWaitTimer();
				const cancelled =
					error.name === "AbortError" ||
					error.message === "Compaction cancelled" ||
					error.message.includes("cancelled");
				notify(
					ctx,
					cancelled ? "Hot-swap compaction cancelled." : `Hot-swap compaction failed: ${error.message}`,
					cancelled ? "warning" : "error",
				);
			},
		});
	};

	// --- custom summarizer (optional) ---------------------------------------
	if (summarizerEnv && summarizerEnv !== "partial") {
		const env = summarizerEnv;

		// Cached probed window — resolved once per session on first compaction.
		// undefined = "not yet probed"; number = probed window or undefined-when-failed
		// (we store a sentinel so we don't re-probe a flaky endpoint repeatedly).
		let probedWindow: number | undefined | "probed-missing" = undefined;

		const resolveSummarizerWindow = async (): Promise<number> => {
			if (env.contextWindowHint && env.contextWindowHint > 0) {
				return env.contextWindowHint;
			}
			if (probedWindow === undefined) {
				try {
					const probed = await probeContextWindow(env.baseUrl, env.apiKey, env.model);
					probedWindow = probed ?? "probed-missing";
				} catch {
					probedWindow = "probed-missing";
				}
			}
			if (typeof probedWindow === "number") return probedWindow;
			return FALLBACK_CONTEXT_WINDOW;
		};

		const buildSummaryPrompt = (
			batchMessages: MessagesToSummarize,
			previousSummary: string | undefined,
			customInstructions: string | undefined,
			turnPrefixText: string,
		) => {
			const batchText = serializeConversation(convertToLlm(batchMessages));
			const previousContext = previousSummary
				? `\n\nPrevious session summary for context:\n${previousSummary}`
				: "";
			const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
			const turnContext = turnPrefixText
				? `\n\nFor context, the following messages are kept verbatim and follow the summarized portion (do NOT summarize these — they're the current state):\n<turn-prefix>\n${turnPrefixText}\n</turn-prefix>`
				: "";

			return [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `You are a conversation summarizer. Create a comprehensive summary of the conversation in this batch that captures:${previousContext}${focus}${turnContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the conversation history up to this point, so include all information needed to continue the work effectively. If this is one of several batches, build on the previous summary — preserve its conclusions and add only the new information from this batch.

Format the summary as structured markdown with clear sections.

<conversation>
${batchText}
</conversation>`,
						},
					],
					timestamp: Date.now(),
				},
			];
		};

		const callSummarizer = async (
			ctx: ExtensionContext,
			model: SummarizerModel,
			batchMessages: MessagesToSummarize,
			previousSummary: string | undefined,
			customInstructions: string | undefined,
			turnPrefixText: string,
			signal: AbortSignal,
		): Promise<string> => {
			const summaryMessages = buildSummaryPrompt(batchMessages, previousSummary, customInstructions, turnPrefixText);
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{ maxTokens: 8192, signal, cacheRetention: "none", sessionId: randomUUID() },
			);
			return response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		};

		/**
		 * Runs the chunked summarization path: resolves the real summarizer
		 * window, splits the backlog into batches if needed, and produces a
		 * rolling summary across iterations. Returns undefined on abort so
		 * pi's default summarization can take over.
		 */
		const summarizeWithChunking = async (
			ctx: ExtensionContext,
			model: SummarizerModel,
			messagesToSummarize: MessagesToSummarize,
			turnPrefixMessages: MessagesToSummarize,
			customInstructions: string | undefined,
			signal: AbortSignal,
			uiNotify: Notify,
		): Promise<string | undefined> => {
			const window = await resolveSummarizerWindow();
			const maxBatchTokens = Math.max(1024, window - RESERVE_TOKENS - PROMPT_OVERHEAD_TOKENS);
			const turnPrefixText = serializeConversation(convertToLlm(turnPrefixMessages));

			const totalEstimatedTokens = estimateTokens(
				serializeConversation(convertToLlm(messagesToSummarize)) +
					turnPrefixText +
					PROMPT_OVERHEAD_TOKENS * 4,
			);

			// Single-shot fast path: everything fits in one batch.
			if (totalEstimatedTokens <= maxBatchTokens) {
				return await callSummarizer(
					ctx,
					model,
					messagesToSummarize,
					undefined,
					customInstructions,
					turnPrefixText,
					signal,
				);
			}

			uiNotify(
				`Hot-swap summarizer: conversation (~${totalEstimatedTokens} estimated tokens) exceeds summarizer window (${window}); chunking.`,
				"info",
			);

			const batches = chunkMessages(messagesToSummarize, maxBatchTokens);
			let rollingSummary: string | undefined;

			for (let i = 0; i < batches.length; i++) {
				if (signal.aborted) return undefined;
				const batch = batches[i];
				if (batches.length > 1) {
					uiNotify(
						`Hot-swap summarizer: chunked summary ${i + 1}/${batches.length}...`,
						"info",
					);
				}
				const cappedPrev = rollingSummary
					? capSummaryLength(rollingSummary, PREVIOUS_SUMMARY_CAP_TOKENS)
					: undefined;
				rollingSummary = await callSummarizer(
					ctx,
					model,
					batch,
					cappedPrev,
					customInstructions,
					turnPrefixText,
					signal,
				);
			}

			return rollingSummary;
		};

		pi.on("session_before_compact", async (event, ctx) => {
			const { preparation, signal, customInstructions } = event;
			const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId } = preparation;

			if (!providerRegistered) {
				pi.registerProvider(env.providerId, {
					name: "Hot-swap Summarizer",
					baseUrl: env.baseUrl,
					apiKey: "$" + API_KEY_ENV,
					api: "openai-completions",
					models: [
						{
							id: env.model,
							name: env.model,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							// Advertise a large window so pi doesn't pre-truncate;
							// chunking uses the resolved real window instead.
							contextWindow: 1_000_000,
							maxTokens: 8192,
						},
					],
				});
				providerRegistered = true;
			}

			const model = ctx.modelRegistry.find(env.providerId, env.model);
			if (!model) {
				notify(ctx, "Hot-swap summarizer model not found, using default compaction", "warning");
				return;
			}

			const uiNotify: Notify = (message, level) => notify(ctx, message, level);

			// Phase 1: try the chunking path with the resolved window. This
			// either single-shots (when the conversation fits) or pre-chunks
			// before any API call, so the upstream never sees an over-sized
			// prompt.
			try {
				const summary = await summarizeWithChunking(
					ctx,
					model,
					messagesToSummarize,
					turnPrefixMessages,
					customInstructions,
					signal,
					uiNotify,
				);
				if (signal.aborted) return;
				if (!summary || !summary.trim()) {
					if (!signal.aborted) notify(ctx, "Hot-swap summary was empty, using default compaction", "warning");
					return;
				}
				return {
					compaction: { summary, firstKeptEntryId, tokensBefore, usage: undefined },
				};
			} catch (error) {
				if (signal.aborted) return;
				if (!isContextOverflowError(error)) {
					// Non-overflow error: re-throw-equivalent (let pi fall back).
					const message = error instanceof Error ? error.message : String(error);
					notify(
						ctx,
						`Hot-swap summarization failed: ${message} (falling back to default compaction with the session model)`,
						"warning",
					);
					return;
				}

				// Phase 2 fallback: chunking-path estimate was off (or wasn't
				// run because the window was unprobed). Retry with a stricter
				// batch budget — 50% of the previous estimate — to leave room
				// for whatever the estimator under-counted.
				const message = error instanceof Error ? error.message : String(error);
				notify(
					ctx,
					`Hot-swap summarizer hit context overflow (${message}); retrying with tighter chunking.`,
					"info",
				);

				try {
					const window = await resolveSummarizerWindow();
					const tightBudget = Math.max(1024, Math.floor((window - RESERVE_TOKENS - PROMPT_OVERHEAD_TOKENS) / 2));
					const turnPrefixText = serializeConversation(convertToLlm(turnPrefixMessages));
					const batches = chunkMessages(messagesToSummarize, tightBudget);
					let rollingSummary: string | undefined;
					for (let i = 0; i < batches.length; i++) {
						if (signal.aborted) return;
						if (batches.length > 1) {
							uiNotify(
								`Hot-swap summarizer: tight chunk ${i + 1}/${batches.length}...`,
								"info",
							);
						}
						const cappedPrev = rollingSummary
							? capSummaryLength(rollingSummary, PREVIOUS_SUMMARY_CAP_TOKENS)
							: undefined;
						rollingSummary = await callSummarizer(
							ctx,
							model,
							batches[i],
							cappedPrev,
							customInstructions,
							turnPrefixText,
							signal,
						);
					}
					if (signal.aborted) return;
					if (!rollingSummary || !rollingSummary.trim()) {
						notify(ctx, "Hot-swap summary was empty after retry, using default compaction", "warning");
						return;
					}
					return {
						compaction: { summary: rollingSummary, firstKeptEntryId, tokensBefore, usage: undefined },
					};
				} catch (retryError) {
					if (signal.aborted) return;
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					notify(
						ctx,
						`Hot-swap summarization failed after retry: ${retryMessage} (falling back to default compaction with the session model)`,
						"warning",
					);
					return;
				}
			}
		});
	}

	// --- idle tracking + deferred trigger -------------------------------------
	// A turn starting invalidates the idle window; a turn ending re-arms it.
	pi.on("turn_start", (_event, ctx) => {
		idleSince = undefined;
		void ctx;
	});
	pi.on("turn_end", (_event, ctx) => {
		markIdleState(ctx);
		tryStartPendingCompaction(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		markIdleState(ctx);
		tryStartPendingCompaction(ctx);
	});

	/**
	 * Start a queued compaction if the session is now safe. Otherwise keep
	 * polling on a timer.
	 */
	function tryStartPendingCompaction(ctx: ExtensionContext) {
		if (!pending || compacting) return;
		markIdleState(ctx);
		if (isSafeToCompact(ctx)) {
			runCompaction(ctx, pendingInstructions);
		}
	}

	function queueCompaction(ctx: ExtensionContext, customInstructions?: string, options?: { silent?: boolean }) {
		pending = true;
		pendingInstructions = customInstructions;
		const startedAt = Date.now();
		clearWaitTimer();
		waitTimer = setTimeout(function poll() {
			waitTimer = undefined;
			if (!pending || compacting) return;
			if (Date.now() - startedAt > SAFE_TO_COMPACT_TIMEOUT_MS) {
				pending = false;
				pendingInstructions = undefined;
				notify(
					ctx,
					"Hot-swap compaction gave up waiting for the session to go idle. " +
						"Re-run /hot-swap-compact when the current work finishes.",
					"warning",
				);
				return;
			}
			markIdleState(ctx);
			if (isSafeToCompact(ctx)) {
				runCompaction(ctx, pendingInstructions);
				return;
			}
			waitTimer = setTimeout(poll, SAFE_TO_COMPACT_POLL_MS);
			// Unref every re-armed timer, not just the first one: a queued
			// compaction must never hold the host's event loop open while it
			// waits for a safe window.
			waitTimer.unref?.();
		}, SAFE_TO_COMPACT_POLL_MS);
		waitTimer.unref?.();
		if (!options?.silent) {
			notify(
				ctx,
				"Session is busy — hot-swap compaction queued; it will run in the background as soon as the current work finishes.",
				"info",
			);
		}
	}

	// --- command -------------------------------------------------------------
	pi.registerCommand("hot-swap-compact", {
		description: "Compact the session context in the background and hot-swap the live context window when done (non-blocking)",
		handler: async (args, ctx) => {
			if (compacting) {
				notify(ctx, "Hot-swap compaction is already running.", "info");
				return;
			}
			if (pending) {
				notify(ctx, "Hot-swap compaction is already queued and will run when the current turn ends.", "info");
				return;
			}
			const customInstructions = args.trim() || undefined;
			markIdleState(ctx);
			if (isSafeToCompact(ctx)) {
				runCompaction(ctx, customInstructions);
			} else {
				// A turn is in flight, a looper is scheduled between turns, or
				// the idle window is not yet stable. All three would be aborted
				// by ctx.compact(), so queue and wait for a safe window.
				queueCompaction(ctx, customInstructions);
			}
		},
	});
}
