#!/usr/bin/env node
/**
 * Smoke test for the chunked-summarization path.
 *
 * Architecture: one child subprocess per scenario. Each subprocess imports
 * index.ts fresh (so its module-load `process.env` reads see the scenario's
 * overrides), drives the registered handler with a mocked pi runtime, and
 * prints a JSON result line on stdout. The parent parses + asserts.
 *
 * Why subprocesses: `resolveSummarizerEnv()` runs once at module-load and
 * reads `process.env` directly, so we can't change env between scenarios
 * in one process. Spawning fresh gives each scenario a clean module cache.
 *
 * Run with:  node scripts/smoke.mjs
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// --- tiny test harness --------------------------------------------------------

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = "") {
	passed++;
	console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}
function fail(name, detail) {
	failed++;
	failures.push({ name, detail });
	console.log(`  ${RED}✗${RESET} ${name}\n      ${RED}${detail}${RESET}`);
}
function section(title) {
	console.log(`\n${YELLOW}▶ ${title}${RESET}`);
}
function assertEqual(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) ok(name, `${DIM}${a}${RESET}`);
	else fail(name, `expected ${e}, got ${a}`);
}
function assertTrue(name, cond, detail = "") {
	if (cond) ok(name, detail);
	else fail(name, detail || "expected truthy, got falsy");
}

// --- subprocess runner --------------------------------------------------------

/**
 * Runs the scenario in a clean subprocess with the given env vars.
 * Returns { ok, result, stderr } parsed from the subprocess JSON output.
 */
function runScenario(scenarioName, envVars) {
	const childScript = path.join(HERE, "_scenario-runner.mjs");
	const result = spawnSync(process.execPath, [childScript, scenarioName], {
		cwd: ROOT,
		env: { ...process.env, ...envVars },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		return {
			ok: false,
			stderr: result.stderr || "",
			stdout: result.stdout || "",
			status: result.status,
		};
	}
	try {
		const json = result.stdout.trim().split("\n").at(-1);
		return { ok: true, result: JSON.parse(json), stderr: result.stderr || "" };
	} catch (e) {
		return { ok: false, stderr: `JSON parse: ${e.message}\nstdout: ${result.stdout}`, stdout: result.stdout, status: 0 };
	}
}

// --- scenarios ----------------------------------------------------------------

function withEnv(envVars, fn) {
	const prev = {};
	for (const [k, v] of Object.entries(envVars)) {
		prev[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function main() {
	section("Scenario 1: no env vars set — handler NOT registered");
	{
		const out = runScenario("no-env", {});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("handlerRegistered", out.result.handlerRegistered, false);
		}
	}

	section("Scenario 2: partial config — handler NOT registered, stderr warning");
	{
		const out = runScenario("partial-config", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "ollama",
			// MODEL missing
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("handlerRegistered", out.result.handlerRegistered, false);
			assertTrue("stderr warns about missing MODEL", (out.stderr || "").includes("PI_HOTSWAP_SUMMARIZER_MODEL"));
		}
	}

	section("Scenario 3: full env + small conversation — single-shot path");
	{
		const out = runScenario("single-shot", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "128000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("handlerRegistered", out.result.handlerRegistered, true);
			assertEqual("completeCalls", out.result.completeCalls, 1);
			assertEqual("provider registered", out.result.providerRegistered, true);
			assertEqual("advertised contextWindow", out.result.providerContextWindow, 1_000_000);
			assertEqual("returned summary is single-shot text", out.result.returnedSummary, "stub-summary-1");
		}
	}

	section("Scenario 4: full env + huge conversation — chunked path runs multiple calls");
	{
		const out = runScenario("chunked", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "128000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertTrue("completeCalls > 1 (chunked)", out.result.completeCalls > 1, `got ${out.result.completeCalls}`);
			assertTrue("chunk notification fired", out.result.chunkNotifications >= 1, `got ${out.result.chunkNotifications}`);
			assertTrue("exceeds-window notification fired", out.result.exceedsWindowNotification >= 1);
			assertEqual("returned summary is the LAST rolling summary", out.result.returnedSummary, `stub-summary-${out.result.completeCalls}`);
		}
	}

	section("Scenario 5: context-overflow error → catch-path tighter chunking");
	{
		const out = runScenario("overflow-fallback", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "128000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertTrue("returned summary after retry", !!out.result.returnedSummary);
			assertTrue("completeCalls >= 2 (initial + retry)", out.result.completeCalls >= 2, `got ${out.result.completeCalls}`);
		}
	}

	section("Scenario 6: invalid CONTEXT_WINDOW env var — falls back to probe (warns)");
	{
		const out = runScenario("bad-window", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "not-a-number",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("handler still registered", out.result.handlerRegistered, true);
			assertTrue("stderr warns about bad CONTEXT_WINDOW", (out.stderr || "").includes("PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW"));
		}
	}

	section("Scenario 7: probe endpoint returns a context window — probe is used");
	{
		// We start a tiny HTTP server in the subprocess that responds to /models
		// with a context_window field. The runner checks that the chunking
		// path fired (meaning the probe succeeded and the resolved window was
		// applied), not the 128K fallback.
		const out = runScenario("probe-success", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://127.0.0.1:0", // overridden by runner
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			// CONTEXT_WINDOW_ENV deliberately unset — probe is the only source
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("handlerRegistered", out.result.handlerRegistered, true);
			// Parse the "exceeds summarizer window (N)" notification to get the resolved window.
			const exceedsMatch = (out.result.exceedsWindowText || "").match(/window \((\d+)\)/);
			const resolvedWindow = exceedsMatch ? Number.parseInt(exceedsMatch[1], 10) : undefined;
			assertTrue("probe supplied the window (65536, not the 128000 fallback)", resolvedWindow === 65536, `got ${resolvedWindow} from "${out.result.exceedsWindowText}"`);
		}
	}

	section("Scenario 8: env hint does NOT affect advertised model contextWindow");
	{
		// Use a conversation large enough to trigger chunking under any window;
		// the asserted behavior is that advertised window stays 1M while the
		// chunking path actually fires (completeCalls > 1).
		const out = runScenario("hint-vs-registered", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "64000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("provider registered", out.result.providerRegistered, true);
			assertEqual("advertised window is 1_000_000 regardless of hint", out.result.providerContextWindow, 1_000_000);
			assertTrue("chunking fired (completeCalls > 1)", out.result.completeCalls > 1, `got ${out.result.completeCalls}`);
		}
	}

	section("Scenario 9: goal-mode inter-turn gap must NOT compact (regression for the abort)");
	{
		const out = runScenario("looper-gap", {});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("compact NEVER called during the looper's 50ms gap", out.result.compactCalls, 0);
			assertTrue("user told it was queued", (out.result.notifications || []).some((m) => m.includes("queued")), JSON.stringify(out.result.notifications));
		}
	}

	section("Scenario 10: stable-idle session DOES compact");
	{
		const out = runScenario("stable-idle", {});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("compact called once after the idle window matured", out.result.compactCalls, 1);
		}
	}

	section("Scenario 11: PI_HOTSWAP_SUMMARIZER_IDLE_MS shortens the idle window");
	{
		const out = runScenario("custom-idle-window", {
			PI_HOTSWAP_SUMMARIZER_IDLE_MS: "100",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertEqual("compact called once", out.result.compactCalls, 1);
			// With a 100 ms window the first 250 ms poll tick fires the
			// compaction (~300 ms); the 750 ms default cannot fire before ~1 s.
			assertTrue(
				"compacted well before the default 750 ms window would allow",
				typeof out.result.compactElapsedMs === "number" && out.result.compactElapsedMs > 0 && out.result.compactElapsedMs < 800,
				`compact fired after ${out.result.compactElapsedMs} ms`,
			);
		}
	}

	section("Scenario 12: invalid PI_HOTSWAP_SUMMARIZER_IDLE_MS warns and falls back to the default");
	{
		const out = runScenario("bad-idle-window", {
			PI_HOTSWAP_SUMMARIZER_IDLE_MS: "soon",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertTrue("stderr warns about bad IDLE_MS", (out.stderr || "").includes("PI_HOTSWAP_SUMMARIZER_IDLE_MS"));
			assertEqual("still compacts via the default window", out.result.compactCalls, 1);
		}
	}

	section("Scenario 13: output token cap on single-shot — bisects into multiple calls");
	{
		const out = runScenario("truncated-single", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "128000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			// 1 truncated single-shot + 1 full-batch retry (also truncated)
			// + bisected 3-message and 2-message batches.
			assertEqual("completeCalls", out.result.completeCalls, 4);
			assertEqual("returned summary is the LAST rolling summary", out.result.returnedSummary, "stub-summary-4");
			assertTrue("cap-switch notification fired", out.result.capSwitchNotifications >= 1);
			assertTrue("batch split notification fired", out.result.splitNotifications >= 1);
			assertEqual("no partial-summary warnings", out.result.partialSummaryWarnings, 0);
		}
	}

	section("Scenario 14: output token cap down to a single message — keeps partial summary with warning");
	{
		const out = runScenario("truncated-single-message", {
			PI_HOTSWAP_SUMMARIZER_BASE_URL: "http://localhost:11434/v1",
			PI_HOTSWAP_SUMMARIZER_API_KEY: "test",
			PI_HOTSWAP_SUMMARIZER_MODEL: "test-model",
			PI_HOTSWAP_SUMMARIZER_CONTEXT_WINDOW: "128000",
		});
		assertTrue("subprocess OK", out.ok, out.stderr);
		if (out.ok) {
			assertTrue("compaction still returned a summary", !!out.result.returnedSummary);
			assertTrue("partial-summary warning fired", out.result.partialSummaryWarnings >= 1, `got ${out.result.partialSummaryWarnings}`);
		}
	}

	console.log("");
	if (failed === 0) {
		console.log(`${GREEN}✓ All ${passed} checks passed${RESET}`);
		process.exit(0);
	} else {
		console.log(`${RED}✗ ${failed} of ${passed + failed} checks failed${RESET}`);
		for (const f of failures) console.log(`  ${RED}- ${f.name}: ${f.detail}${RESET}`);
		process.exit(1);
	}
}

main().catch(err => {
	console.error(`${RED}smoke test crashed: ${err.stack}${RESET}`);
	process.exit(2);
});
