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
 *   PI_HOTSWAP_SUMMARIZER_BASE_URL   OpenAI-compatible endpoint
 *   PI_HOTSWAP_SUMMARIZER_API_KEY    API key for that endpoint
 *   PI_HOTSWAP_SUMMARIZER_MODEL      model id to summarize with
 *   PI_HOTSWAP_SUMMARIZER_PROVIDER   optional provider id label
 *                                    (default "hotswap-summarizer")
 *
 * Install: copy or symlink this directory into ~/.pi/agent/extensions or a
 * project's .pi/extensions, or run ad-hoc with `pi -e path/to/index.ts`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const BASE_URL_ENV = "PI_HOTSWAP_SUMMARIZER_BASE_URL";
const API_KEY_ENV = "PI_HOTSWAP_SUMMARIZER_API_KEY";
const MODEL_ENV = "PI_HOTSWAP_SUMMARIZER_MODEL";
const PROVIDER_ENV = "PI_HOTSWAP_SUMMARIZER_PROVIDER";

const DEFAULT_PROVIDER_ID = "hotswap-summarizer";

interface HotswapSummarizerEnv {
	baseUrl: string;
	apiKey: string;
	model: string;
	providerId: string;
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
			`[hot-swap-compact] ${PROVIDER_ENV.replace("PROVIDER", "SUMMARIZER")} override is incomplete ` +
				`(missing: ${missing.join(", ")}). Falling back to the session's current model for compaction.`,
		);
		return "partial";
	}
	return { baseUrl, apiKey, model, providerId };
}

export default function (pi: ExtensionAPI) {
	// --- state -------------------------------------------------------------
	let pending = false;
	let pendingInstructions: string | undefined;
	let compacting = false;
	let providerRegistered = false;
	// Entry count captured at trigger time so the completion notice can tell
	// the user the backlog range that was swapped.
	let triggerEntryCount: number | undefined;

	const summarizerEnv = resolveSummarizerEnv();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const runCompaction = (ctx: ExtensionContext, customInstructions?: string) => {
		compacting = true;
		try {
			triggerEntryCount = ctx.sessionManager.getEntries().length;
		} catch {
			triggerEntryCount = undefined;
		}
		notify(ctx, `Hot-swap compaction started in background (turn ${triggerEntryCount ?? "?"})...`, "info");
		ctx.compact({
			customInstructions,
			onComplete: () => {
				compacting = false;
				pending = false;
				pendingInstructions = undefined;
				notify(
					ctx,
					triggerEntryCount !== undefined
						? `Hot swap applied: context replaced by summary (backlog through turn ${triggerEntryCount}).`
						: "Hot swap applied: context replaced by summary.",
					"info",
				);
			},
			onError: (error) => {
				compacting = false;
				pending = false;
				pendingInstructions = undefined;
				notify(ctx, `Hot-swap compaction failed: ${error.message}`, "error");
			},
		});
	};

	// --- custom summarizer (optional) ---------------------------------------
	if (summarizerEnv && summarizerEnv !== "partial") {
		const env = summarizerEnv;

		pi.on("session_before_compact", async (event, ctx) => {
			const { preparation, signal } = event;
			const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } =
				preparation;

			if (!providerRegistered) {
				providerRegistered = true;
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
							contextWindow: 1_000_000,
							maxTokens: 8192,
						},
					],
				});
			}

			const model = ctx.modelRegistry.find(env.providerId, env.model);
			if (!model) {
				notify(ctx, "Hot-swap summarizer model not found, using default compaction", "warning");
				return;
			}

			const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
			const conversationText = serializeConversation(convertToLlm(allMessages));
			const previousContext = previousSummary
				? `\n\nPrevious session summary for context:\n${previousSummary}`
				: "";

			const summaryMessages = [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the conversation history up to this point, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
						},
					],
					timestamp: Date.now(),
				},
			];

			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{ messages: summaryMessages },
					{ maxTokens: 8192, signal, cacheRetention: "none", sessionId: randomUUID() },
				);
				const summary = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (!summary.trim()) {
					if (!signal.aborted) notify(ctx, "Hot-swap summary was empty, using default compaction", "warning");
					return;
				}
				return {
					compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `Hot-swap summarization failed: ${message} (falling back is not possible; compaction aborted)`, "error");
				return;
			}
		});
	}

	// --- deferred trigger on turn_end ---------------------------------------
	pi.on("turn_end", (_event, ctx) => {
		if (!pending || compacting) return;
		runCompaction(ctx, pendingInstructions);
	});

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
			if (ctx.isIdle()) {
				runCompaction(ctx, customInstructions);
			} else {
				// AgentSession.compact() aborts the in-flight turn, so defer.
				pending = true;
				pendingInstructions = customInstructions;
				notify(
					ctx,
					"Session is busy — hot-swap compaction queued; it will run in the background when the current turn ends.",
					"info",
				);
			}
		},
	});
}
