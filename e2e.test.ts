/**
 * pi-notify e2e tests against a real pi binary (bun test).
 *
 * Integration tests in unit-test form: `bun test` runs them right after the
 * pure unit tests. Each scenario launches the real `pi` CLI in print mode
 * with an isolated config directory (PI_CODING_AGENT_DIR, generated at
 * runtime — no user settings/credentials) and only this project's index.ts
 * loaded via `-e`. The LLM is an in-process OpenAI-compatible HTTP server on
 * a dynamic port that never returns tool calls, so the agent settles after
 * one turn and pi-notify's agent_settled path fires.
 *
 * The suite skips automatically when no `pi` binary is on PATH. The toast
 * scenario pops a real notification: on by default on Windows, off by
 * default elsewhere (PI_NOTIFY_E2E_TOAST=1 opts in; PI_NOTIFY_E2E_NO_TOAST=1
 * opts out).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = import.meta.dir;
const EXTENSION = path.join(REPO, "index.ts");
const MOCK_HOST = "127.0.0.1";
const PI_NAME = "e2e-test";
const RUN_TIMEOUT_MS = 60_000;
// Windows pops a real toast, so the scenario is on by default there; other
// platforms opt in via PI_NOTIFY_E2E_TOAST=1. Set PI_NOTIFY_E2E_NO_TOAST=1
// to skip it on Windows.
const TOAST_ENABLED =
	process.env.PI_NOTIFY_E2E_TOAST === "1" ||
	(process.platform === "win32" && process.env.PI_NOTIFY_E2E_NO_TOAST !== "1");

// ── availability gate ────────────────────────────────────────────────────────
// Resolve `pi` through PATH exactly once with Bun.which, then spawn the
// absolute path. Passing a bare command name to Bun.spawn can fail with
// `uv_spawn ENOENT` on Windows even when the same PATH resolves it (the
// async spawn path does not always do PATH/.cmd lookup) — an absolute
// .cmd/.exe path is spawned deterministically.
const PI_ENTRY = (() => {
	try {
		return Bun.which("pi") ?? null;
	} catch {
		return null;
	}
})();
const PI_AVAILABLE = PI_ENTRY !== null;
if (!PI_AVAILABLE) {
	console.error("[e2e] pi binary not found on PATH — skipping real-pi e2e tests");
}

/**
 * Tiny extension loaded alongside pi-notify in the isolated config dir: on
 * `session_start` it broadcasts `permissions:ui_prompt` exactly like
 * @gotgenes/pi-permission-system does before showing an ask dialog.
 */
const HELPER_EXTENSION = "permission-emitter.ts";
const HELPER_EXTENSION_CONTENT = `// e2e helper: emit a permissions:ui_prompt broadcast like the permission system does.
export default function (pi: any) {
    pi.on("session_start", () => {
        pi.events.emit("permissions:ui_prompt", {
            requestId: "e2e-req-1",
            source: "tool_call",
            surface: "bash",
            value: "git status",
            agentName: null,
            message: "Run git status in the project directory?",
            forwarding: null,
        });
    });
}
`;

// ── helpers (no test logic here — the 9 scenarios live in the describe) ──────

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

interface MockServer {
	server: Server;
	port: number;
	/** One line per chat completion request, for counting agent runs. */
	requestLog: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** OSC 777 payloads as `title;body` strings found in stderr. */
function parseOsc777(stderr: string): string[] {
	const out: string[] = [];
	for (const m of stderr.matchAll(/\x1b\]777;notify;([^\x07]+)\x07/g)) out.push(m[1]);
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("")
			.trim();
	}
	return "";
}

function sseChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
	return `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

/** In-process mock LLM: OpenAI Chat Completions subset, never tool-calls. */
async function startMockServer(): Promise<MockServer> {
	const requestLog: string[] = [];
	let requestCount = 0;
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let parsed: {
				stream?: boolean;
				stream_options?: { include_usage?: boolean };
				model?: string;
				messages?: Array<{ role?: string; content?: unknown }>;
			} | null = null;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch {
				// malformed body — pi would not send one
			}

			if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [] }));
				return;
			}

			if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
				requestCount += 1;
				const n = requestCount;
				const messages = parsed?.messages ?? [];
				const lastUser = [...messages].reverse().find((m) => m.role === "user");
				requestLog.push(
					`request #${n} stream=${parsed?.stream ?? false} messages=${messages.length} lastUser=${JSON.stringify(textOf(lastUser?.content ?? null)).slice(0, 120)}`,
				);

				const reply = `Mock LLM reply to request #${n}.`;
				const id = `chatcmpl-e2e-${n}`;
				const model = parsed?.model ?? "mock-1";

				if (parsed?.stream) {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					res.write(sseChunk(id, model, { role: "assistant" }, null));
					for (const word of reply.split(" ")) {
						res.write(sseChunk(id, model, { content: `${word} ` }, null));
					}
					res.write(sseChunk(id, model, {}, "stop"));
					if (parsed.stream_options?.include_usage) {
						res.write(
							`data: ${JSON.stringify({
								id,
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1000),
								model,
								choices: [],
								usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
							})}\n\n`,
						);
					}
					res.end("data: [DONE]\n\n");
					return;
				}

				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id,
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: reply },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
					}),
				);
				return;
			}

			res.writeHead(404, { "content-type": "text/plain" });
			res.end(`not found: ${req.method} ${req.url}`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, MOCK_HOST, resolve));
	const addr = server.address();
	if (!addr || typeof addr !== "object") {
		throw new Error("mock LLM server failed to obtain a listening port");
	}
	return { server, port: addr.port, requestLog };
}

/** Isolated config dir: only a mock provider + quiet startup. No auth, no
 * user settings, no extension discovery (the -e flag covers that). */
function writeIsolatedConfig(configDir: string, port: number): void {
	writeFileSync(
		path.join(configDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					"mock-notify": {
						baseUrl: `http://${MOCK_HOST}:${port}/v1`,
						api: "openai-completions",
						apiKey: "dummy-key",
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						models: [
							{
								id: "mock-1",
								name: "Mock LLM",
								reasoning: false,
								input: ["text"],
								contextWindow: 32768,
								maxTokens: 2048,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ quietStartup: true }));
}

/** Environment for the pi child: isolated config dir + forced OSC path.
 * Delete (not blank) the PI_NOTIFY_* and WT_SESSION variables: pi-notify's
 * `??` treats an empty string as a valid override, so blanking them would
 * not neutralize values inherited from the outer shell. */
function piEnv(configDir: string, extraEnv: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	delete env.WT_SESSION;
	delete env.PI_NOTIFY_TITLE;
	delete env.PI_NOTIFY_BODY;
	delete env.PI_NOTIFY_SOUND_CMD;
	delete env.PI_NOTIFY_FOCUS_CMD;
	delete env.PI_NOTIFY_PERMISSION_TITLE;
	delete env.PI_NOTIFY_PERMISSION_BODY;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: configDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		...extraEnv,
	});
	return env;
}

/** Run real pi in print mode against the mock LLM, return captured output.
 *
 * Must be async: Bun's synchronous spawnSync blocks the event loop, so the
 * in-process mock HTTP server could never answer pi's LLM requests (dead-
 * lock). Async spawn leaves the loop free. */
async function runPi(
	configDir: string,
	messages: string[],
	extraEnv: Record<string, string> = {},
	extraExtensions: string[] = [],
): Promise<RunResult> {
	const args = [
		"-p",
		"-ne", // no extension discovery — only the explicit -e paths load
		"-nc", // no AGENTS.md / context files
		"-nt", // no tools — the mock LLM never calls any anyway
		"--offline",
		"--provider", "mock-notify",
		"--model", "mock-1",
		"--api-key", "dummy-key",
		"-e", EXTENSION,
		...extraExtensions.flatMap((ext) => ["-e", path.join(configDir, ext)]),
		"--name", PI_NAME,
		...messages,
	];
	const proc = Bun.spawn([PI_ENTRY!, ...args], {
		cwd: REPO,
		env: piEnv(configDir, extraEnv),
		// stdin: "ignore" keeps pi's stdin-isTTY detection stable no matter
		// what terminal (or pipe) the test suite itself runs under.
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stdout = "";
	let stderr = "";
	let exitCode: number | null = null;
	try {
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		stdout = out;
		stderr = err;
		exitCode = await Promise.race([
			proc.exited,
			sleep(RUN_TIMEOUT_MS).then(() => {
				proc.kill();
				throw new Error(`pi did not exit within ${RUN_TIMEOUT_MS}ms (messages: ${JSON.stringify(messages)})`);
			}),
		]);
	} catch (err) {
		// Surface spawn/IO failures with the full context: without this the
		// test would fail with a bare "Executable not found" or stream error.
		throw new Error(
			`runPi failed (messages: ${JSON.stringify(messages)}, exitCode: ${exitCode}): ${err instanceof Error ? err.message : String(err)}\nstderr: ${stderr.slice(0, 500)}`,
		);
	}
	return { stdout, stderr, exitCode };
}

// ── scenarios ────────────────────────────────────────────────────────────────

describe.skipIf(!PI_AVAILABLE)("pi-notify e2e (real pi)", () => {
	let mock: MockServer;
	let configDir: string;

	beforeAll(async () => {
		configDir = mkdtempSync(path.join(tmpdir(), "pi-notify-e2e-"));
		mock = await startMockServer();
		writeIsolatedConfig(configDir, mock.port);
		writeFileSync(path.join(configDir, HELPER_EXTENSION), HELPER_EXTENSION_CONTENT);
	}, 30_000);

	afterAll(() => {
		mock?.server.close();
		rmSync(configDir, { recursive: true, force: true });
	});

	test(
		"settle emits one OSC 777 notification with title and body",
		async () => {
			const run = await runPi(configDir, ["Say hello"]);
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			const osc = parseOsc777(run.stderr);
			expect(osc.length, run.stderr.slice(0, 2000)).toBe(1);
			const [title, body] = osc[0].split(";");
			expect(title).toBe("Pi — e2e-test");
			expect(body).toBe('Done: "Say hello"');
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"permissions:ui_prompt broadcasts an approval notification",
		async () => {
			// The helper extension emits the broadcast on session_start, before
			// the agent run; the permission notify then starts the cooldown, so
			// the later settle is deduped and only one OSC payload appears.
			const run = await runPi(configDir, ["Say hello"], {}, [HELPER_EXTENSION]);
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			const osc = parseOsc777(run.stderr);
			expect(osc.length, run.stderr.slice(0, 2000)).toBe(1);
			const [title, body] = osc[0].split(";");
			expect(title).toBe("Pi needs approval — e2e-test");
			expect(body).toBe("Run git status in the project directory?");
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"cooldown: two agent runs in one process notify only once",
		async () => {
			const before = mock.requestLog.length;
			const run = await runPi(configDir, ["First message", "Second message"]);
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			// Both agent runs really happened — only the first notify passes
			// the COOLDOWN_MS gate.
			expect(mock.requestLog.length - before, mock.requestLog.join("\n")).toBe(2);
			const osc = parseOsc777(run.stderr);
			expect(osc.length, run.stderr.slice(0, 2000)).toBe(1);
			expect(osc[0].split(";")[1]).toBe('Done: "First message"');
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"PI_NOTIFY_FOCUS_CMD exit 0 suppresses the notification",
		async () => {
			const run = await runPi(configDir, ["Say hello"], { PI_NOTIFY_FOCUS_CMD: "exit /b 0" });
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			expect(parseOsc777(run.stderr).length, run.stderr.slice(0, 2000)).toBe(0);
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"PI_NOTIFY_FOCUS_CMD exit 1 lets the notification through",
		async () => {
			const run = await runPi(configDir, ["Say hello"], { PI_NOTIFY_FOCUS_CMD: "exit /b 1" });
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			expect(parseOsc777(run.stderr).length, run.stderr.slice(0, 2000)).toBe(1);
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"PI_NOTIFY_TITLE/BODY templates resolve {folder} {session} {cwd} {prompt}",
		async () => {
			const run = await runPi(configDir, ["Say hello"], {
				PI_NOTIFY_TITLE: "T-{folder}-{session}",
				PI_NOTIFY_BODY: "B-{cwd}|{prompt}",
			});
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			const osc = parseOsc777(run.stderr);
			expect(osc.length, run.stderr.slice(0, 2000)).toBe(1);
			const [title, body] = osc[0].split(";");
			expect(title).toBe("T-pi-notify-e2e-test");
			expect(body).toBe(`B-${REPO}|Say hello`);
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"control characters and OSC separators are sanitized in the body",
		async () => {
			// BEL in the body would terminate the OSC sequence early if the
			// sanitizer failed; `;` is the OSC field separator.
			const run = await runPi(configDir, ["Say hello"], { PI_NOTIFY_BODY: "line1\u0007line2 ; semi" });
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			const osc = parseOsc777(run.stderr);
			expect(osc.length, run.stderr.slice(0, 2000)).toBe(1);
			const [title, body] = osc[0].split(";");
			expect(title).toBe("Pi — e2e-test");
			// `;` is replaced before whitespace collapsing, so the space after
			// the comma survives: " ; " → " , ".
			expect(body).toBe("line1line2 , semi");
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	test(
		"PI_NOTIFY_SOUND_CMD hook runs when a notification is sent",
		async () => {
			const script = path.join(configDir, "sound.cmd");
			const marker = path.join(configDir, "sound-fired.txt");
			writeFileSync(script, `@echo off\r\necho fired> "${marker}"\r\n`);
			const run = await runPi(configDir, ["Say hello"], { PI_NOTIFY_SOUND_CMD: script });
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			expect(parseOsc777(run.stderr).length, run.stderr.slice(0, 2000)).toBe(1);
			// The hook runs as a detached child, so poll briefly for its marker.
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline && !existsSync(marker)) {
				await sleep(100);
			}
			expect(existsSync(marker), "sound hook marker file was not created").toBe(true);
		},
		{ timeout: RUN_TIMEOUT_MS },
	);

	// Real Windows toast: pops an actual notification. On by default on
	// win32 (configurable via PI_NOTIFY_E2E_NO_TOAST=1), opt-in elsewhere.
	test.skipIf(!TOAST_ENABLED)(
		"WT_SESSION routes to a Windows toast without errors",
		async () => {
			const run = await runPi(configDir, ["Say hello"], { WT_SESSION: "pi-notify-e2e" });
			expect(run.exitCode, run.stderr.slice(0, 2000)).toBe(0);
			expect(parseOsc777(run.stderr).length, run.stderr.slice(0, 2000)).toBe(0);
			expect(run.stderr.includes("toast failed"), run.stderr.slice(0, 2000)).toBe(false);
			// Give pwsh a moment to show the toast before the suite exits.
			await sleep(2500);
		},
		{ timeout: RUN_TIMEOUT_MS },
	);
});
