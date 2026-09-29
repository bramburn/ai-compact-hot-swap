#!/usr/bin/env node
/**
 * Per-scenario runner. Reads SCENARIO_NAME from CLI, builds a mock pi +
 * mock messages per the scenario, drives the registered
 * session_before_compact handler, and prints a JSON result line.
 *
 * Captured stderr is forwarded to the parent so env-var warnings surface
 * in the test output.
 *
 * NOT meant to be run directly — invoked by smoke.mjs.
 */

import { convertToLlm, serializeConversation } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const scenario = process.argv[2] || "no-env";

// --- mock pi ------------------------------------------------------------------

function makeMockPi({ completeImpl, scenarioName }) {
	const handlers = new Map();
	const commands = new Map();
	const providers = new Map();
	const notifyCalls = [];
	// Controllable session state so we can simulate a looper's inter-turn gap.
	const state = { idle: true, pending: false, compactCalls: 0, setIdleAt: null, startedAt: Date.now() };

	const mockModel = {
		id: "test-model",
		name: "test-model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};

	const ctx = {
		hasUI: true,
		ui: {
			notify: (message, level) => notifyCalls.push({ message, level }),
		},
		mode: "tui",
		cwd: process.cwd(),
		sessionManager: { getEntries: () => [] },
		modelRegistry: {
			find: () => mockModel,
			complete: completeImpl,
		},
		model: mockModel,
		isIdle: () => {
			// Simulate a looper starting its next turn `setIdleAt` ms after load.
			if (state.setIdleAt !== null && Date.now() - state.startedAt >= state.setIdleAt) {
				state.idle = false;
			}
			return state.idle;
		},
		hasPendingMessages: () => state.pending,
		abort: () => {},
		getSignal: () => undefined,
		compact: () => {
			state.compactCalls++;
		},
	};

	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		registerProvider(providerId, config) {
			providers.set(providerId, config);
		},
	};

	return { pi, ctx, handlers, commands, providers, notifyCalls, state };
}

// --- fake message builder -----------------------------------------------------

function makeFakeMessages(count, charsPer) {
	const msgs = [];
	for (let i = 0; i < count; i++) {
		msgs.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: "x".repeat(charsPer) }],
			timestamp: Date.now() + i,
		});
	}
	return msgs;
}

// --- scenario dispatch --------------------------------------------------------

async function startProbeServer() {
	// Tiny HTTP server that returns a /models payload with context_window
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		if (req.url === "/models" || req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				// Deliberately NOT the 128_000 fallback, so the assertion
				// proves the value came from the endpoint.
				data: [{ id: "test-model", context_window: 65536 }],
			}));
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function main() {
	let probeServer;
	if (scenario === "probe-success") {
		probeServer = await startProbeServer();
		// Override BASE_URL with the probe server's URL
		process.env.PI_HOTSWAP_SUMMARIZER_BASE_URL = probeServer.url;
	}

	let completeCalls = 0;
	const summaryTexts = [];

	// Build the complete impl per scenario. Each returns a unique stub summary
	// so we can assert that the LAST one is what the handler returned.
	const makeComplete = (behavior) => async () => {
		completeCalls++;
		if (behavior === "overflow-first") {
			if (completeCalls === 1) {
				throw new Error("context_length_exceeded: too many tokens");
			}
		}
		const text = `stub-summary-${completeCalls}`;
		summaryTexts.push(text);
		return { content: [{ type: "text", text }], usage: { inputTokens: 100, outputTokens: 50 } };
	};

	const behaviorMap = {
		"no-env": "always-succeed",
		"partial-config": "always-succeed",
		"single-shot": "always-succeed",
		"chunked": "always-succeed",
		"overflow-fallback": "overflow-first",
		"bad-window": "always-succeed",
		"hint-vs-registered": "always-succeed",
		"probe-success": "always-succeed",
	};
	const completeImpl = makeComplete(behaviorMap[scenario] || "always-succeed");

	const { pi, ctx, handlers, commands, providers, notifyCalls, state } = makeMockPi({ completeImpl, scenarioName: scenario });

	// Scenarios that exercise the command gating rather than the summarizer.
	if (scenario === "looper-gap" || scenario === "stable-idle") {
		// "looper-gap": the looper's next turn starts 50ms from now (pi-goal-x's
		// CONTINUATION_IDLE_RETRY_MS), so an isIdle()-only check would compact
		// into the gap and abort it. "stable-idle": the session stays idle.
		if (scenario === "looper-gap") state.setIdleAt = 50;

		const mod2 = await import(`../index.ts?cb=${Date.now()}-${Math.random()}`);
		mod2.default(pi);

		const command = commands.get("hot-swap-compact");
		await command.handler("", ctx);

		// Give the gating logic time to either fire or settle.
		await new Promise((r) => setTimeout(r, scenario === "looper-gap" ? 1200 : 1500));

		console.log(JSON.stringify({
			scenario,
			compactCalls: state.compactCalls,
			notifications: notifyCalls.map((n) => n.message),
		}));
		return;
	}

	// Dynamic import so process.env is read at module-load time (fresh each subprocess)
	const mod = await import(`../index.ts?cachebust=${Date.now()}-${Math.random()}`);
	mod.default(pi);

	const handlerRegistered = handlers.has("session_before_compact");

	if (!handlerRegistered) {
		// No handler to drive — return early.
		console.log(JSON.stringify({
			scenario,
			handlerRegistered: false,
			completeCalls: 0,
			providerRegistered: providers.size > 0,
			providerContextWindow: providers.get("hotswap-summarizer")?.models?.[0]?.contextWindow,
			returnedSummary: null,
			chunkNotifications: 0,
			exceedsWindowNotification: 0,
			notifyCount: notifyCalls.length,
		}));
		return;
	}

	const handler = handlers.get("session_before_compact");

	// Build messages per scenario
	let messages, turnPrefixMessages;
	switch (scenario) {
		case "single-shot":
		case "bad-window":
			// Small conversation
			messages = makeFakeMessages(5, 4000); // ~5k tokens estimated
			turnPrefixMessages = [];
			break;
		case "hint-vs-registered":
			// Larger conversation so chunking actually fires under any window.
			messages = makeFakeMessages(100, 20000); // ~500k tokens estimated
			turnPrefixMessages = [];
			break;
		case "probe-success":
			// ~200k tokens: over the probed 65_536 window, but cheap to chunk.
			messages = makeFakeMessages(40, 20000);
			turnPrefixMessages = [];
			break;
		case "chunked":
		case "overflow-fallback":
			// Huge conversation
			messages = makeFakeMessages(100, 20000); // ~500k tokens estimated
			turnPrefixMessages = [];
			break;
		default:
			messages = makeFakeMessages(5, 4000);
			turnPrefixMessages = [];
	}

	const ac = new AbortController();
	const event = {
		preparation: {
			firstKeptEntryId: "first-kept",
			messagesToSummarize: messages,
			turnPrefixMessages,
			isSplitTurn: false,
			tokensBefore: 5000,
			previousSummary: undefined,
			fileOps: { readFiles: [], modifiedFiles: [] },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		signal: ac.signal,
		customInstructions: undefined,
	};

	let result;
	try {
		result = await handler(event, ctx);
	} catch (e) {
		console.log(JSON.stringify({
			scenario,
			handlerRegistered: true,
			completeCalls,
			providerRegistered: providers.size > 0,
			providerContextWindow: providers.get("hotswap-summarizer")?.models?.[0]?.contextWindow,
			returnedSummary: null,
			error: String(e?.message || e),
			notifyCount: notifyCalls.length,
		}));
		return;
	}

	console.log(JSON.stringify({
		scenario,
		handlerRegistered: true,
		completeCalls,
		providerRegistered: providers.size > 0,
		providerContextWindow: providers.get("hotswap-summarizer")?.models?.[0]?.contextWindow,
		returnedSummary: result?.compaction?.summary ?? null,
		chunkNotifications: notifyCalls.filter(n => n.message.includes("chunked summary")).length,
		exceedsWindowNotification: notifyCalls.filter(n => n.message.includes("exceeds summarizer window")).length,
		exceedsWindowText: notifyCalls.find(n => n.message.includes("exceeds summarizer window"))?.message || null,
		notifyCount: notifyCalls.length,
	}));

	if (probeServer) probeServer.close();
}

main().catch(err => {
	console.error(`scenario runner crashed: ${err.stack}`);
	process.exit(2);
});
