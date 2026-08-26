// 验证 pi-notify 纯函数通知决策与模板逻辑

import { test, expect } from "bun:test";
import registerExtension, {
	applyCustomizations,
	createState,
	recordInput,
	shouldNotify,
	buildBody,
	buildTitle,
	buildPermissionTitle,
	buildPermissionBody,
	cleanPermissionMessage,
	permissionVars,
	isPermissionUiPrompt,
	resolveTemplates,
	sanitizeOscText,
	stripControlChars,
	resolveIconPath,
	isWSL,
	notifyWindows,
	windowsToastScript,
	toastImageSrc,
	runHandlers,
	registerCustomize,
	tryReadRunnerBound,
	ENGAGEMENT_MS,
	COOLDOWN_MS,
	PERMISSION_BODY_MAX,
	type PermissionUiPromptEvent,
} from "./index.ts";

// Minimal InputEvent stub — avoids importing from @earendil-works/pi-coding-agent at test time
type InputEvent = { source: string; text: string; streamingBehavior?: "steer" | "followUp" };

function inputEvent(partial: Partial<InputEvent>): InputEvent {
	// 构造最小化的输入事件桩
	return { source: "interactive", text: "", ...partial };
}

// --- permission prompts ---

function permissionPrompt(over: Partial<PermissionUiPromptEvent> = {}): PermissionUiPromptEvent {
	// 构造最小化的权限提示事件桩
	return {
		requestId: "req-1",
		source: "tool_call",
		surface: "bash",
		value: "git status",
		agentName: null,
		message: "",
		forwarding: null,
		...over,
	};
}

// --- buildPermissionTitle ---

test("buildPermissionTitle: no who/session falls back to the generic ask", () => {
	expect(buildPermissionTitle(permissionPrompt())).toBe("Pi PA");
});

test("buildPermissionTitle: agentName is shown in the title", () => {
	expect(buildPermissionTitle(permissionPrompt({ agentName: "Coder" }))).toBe("Pi PA (Coder)");
});

test("buildPermissionTitle: forwarded requester wins over agentName", () => {
	expect(
		buildPermissionTitle(
			permissionPrompt({ agentName: "Coder", forwarding: { requesterAgentName: "Explore", requesterSessionId: "s-1" } }),
		),
	).toBe("Pi PA (Explore)");
});

test("buildPermissionTitle: session name is appended when present", () => {
	expect(buildPermissionTitle(permissionPrompt({ agentName: "Coder" }), "my-project")).toBe(
		"Pi PA (Coder) — my-project",
	);
});

test("buildPermissionTitle: folder is used when who/session are missing", () => {
	expect(buildPermissionTitle(permissionPrompt(), undefined, "my-project")).toBe("Pi PA (my-project)");
});

test("buildPermissionTitle: session name wins over folder", () => {
	expect(buildPermissionTitle(permissionPrompt(), "sess", "folder")).toBe("Pi PA — sess");
});

test("buildPermissionTitle: who wins over session and folder", () => {
	expect(buildPermissionTitle(permissionPrompt({ agentName: "Coder" }), "sess", "folder")).toBe(
		"Pi PA (Coder) — sess",
	);
});

// --- buildPermissionBody ---

test("buildPermissionBody: surface + value win over the dialog message", () => {
	expect(buildPermissionBody(permissionPrompt({ message: "Run it?" }))).toBe("bash: git status");
	expect(buildPermissionBody(permissionPrompt())).toBe("bash: git status");
});

test("buildPermissionBody: value equal to surface falls through to the message", () => {
	expect(buildPermissionBody(permissionPrompt({ surface: "bash", value: "bash", message: "Run it?" }))).toBe(
		"Run it?",
	);
});

test("buildPermissionBody: cleaned message when surface/value are missing", () => {
	expect(
		buildPermissionBody(
			permissionPrompt({
				surface: null,
				value: null,
				message: "Current agent requested bash command 'git status'. Allow this command?",
			}),
		),
	).toBe("bash command 'git status'");
});

test("buildPermissionBody: generic fallback when nothing is known", () => {
	expect(buildPermissionBody(permissionPrompt({ message: "", surface: null, value: null }))).toBe(
		"A permission decision is required.",
	);
});

test("buildPermissionBody: value without surface falls back to a permission label", () => {
	expect(buildPermissionBody(permissionPrompt({ surface: null, value: "git status" }))).toBe(
		"permission: git status",
	);
});

test("buildPermissionBody: long values are truncated to 160 chars", () => {
	const label = "bash";
	const budget = PERMISSION_BODY_MAX - label.length - 2;
	expect(buildPermissionBody(permissionPrompt({ value: "x".repeat(200) }))).toBe(
		`${label}: ` + "x".repeat(budget - 1) + "…",
	);
});

// --- cleanPermissionMessage ---

test("cleanPermissionMessage: strips subject prefix, matched noise, and allow-question", () => {
	expect(
		cleanPermissionMessage(
			"Agent 'Coder' requested bash command 'xargs wc -l (matched'<indirection-bash-wrapper>')(full command: 'cd /d/Applications'). Allow this command?",
		),
	).toBe("bash command 'xargs wc -l (full command: 'cd /d/Applications')");
});

test("cleanPermissionMessage: skill-read 'access to' preamble is stripped", () => {
	expect(
		cleanPermissionMessage(
			"Agent 'Coder' requested access to skill 'review' via 'docs/review.md'. Allow this read?",
		),
	).toBe("skill 'review' via 'docs/review.md'");
});

test("cleanPermissionMessage: lowercase 'allow' prose is left intact", () => {
	expect(cleanPermissionMessage("Check the log file. allow me to verify the tail.")).toBe(
		"Check the log file. allow me to verify the tail.",
	);
});

test("cleanPermissionMessage: subagent preamble is stripped, prose collapsed", () => {
	expect(cleanPermissionMessage("Subagent 'Explore' requested permission.\nSession ID: s-1\n\nRun git status?")).toBe(
		"permission. Session ID: s-1 Run git status?",
	);
});

test("cleanPermissionMessage: non-string or empty input becomes empty", () => {
	expect(cleanPermissionMessage(123 as unknown as string)).toBe("");
	expect(cleanPermissionMessage(null as unknown as string)).toBe("");
	expect(cleanPermissionMessage("   ")).toBe("");
});

// --- permissionVars ---

test("permissionVars: maps every known field", () => {
	expect(
		permissionVars(
			permissionPrompt({
				message: "Run it?",
				agentName: "Coder",
				forwarding: { requesterAgentName: "Explore", requesterSessionId: "s-1" },
			}),
		),
	).toEqual({
		permission_surface: "bash",
		permission_value: "git status",
		permission_message: "Run it?",
		permission_agent: "Coder",
		permission_requester: "Explore",
	});
});

test("permissionVars: missing fields become empty strings", () => {
	expect(permissionVars(permissionPrompt())).toEqual({
		permission_surface: "bash",
		permission_value: "git status",
		permission_message: "",
		permission_agent: "",
		permission_requester: "",
	});
});

test("permissionVars: value and message are capped at 500 chars", () => {
	const vars = permissionVars(
		permissionPrompt({ value: "v".repeat(800), message: "m".repeat(800) }),
	);
	expect(vars.permission_value).toBe("v".repeat(500));
	expect(vars.permission_message).toBe("m".repeat(500));
});

// --- isPermissionUiPrompt ---

test("isPermissionUiPrompt: accepts a well-formed prompt payload", () => {
	expect(isPermissionUiPrompt(permissionPrompt())).toBe(true);
});

test("isPermissionUiPrompt: rejects non-objects and empty objects", () => {
	expect(isPermissionUiPrompt(null)).toBe(false);
	expect(isPermissionUiPrompt("notify")).toBe(false);
	expect(isPermissionUiPrompt(42)).toBe(false);
	expect(isPermissionUiPrompt({})).toBe(false);
});

test("permission builders: non-string fields degrade instead of throwing", () => {
	// Cross-extension payloads are untyped at runtime; a field that violates
	// the contract must not crash the notification pipeline.
	const malformed = {
		requestId: 123,
		message: 456,
		surface: "bash",
		value: null,
		agentName: null,
		forwarding: "nope",
	} as unknown as PermissionUiPromptEvent;
	expect(() => buildPermissionBody(malformed)).not.toThrow();
	expect(() => buildPermissionTitle(malformed)).not.toThrow();
	expect(() => permissionVars(malformed)).not.toThrow();
	expect(buildPermissionBody(malformed)).toBe("A permission decision is required.");
	expect(permissionVars(malformed).permission_value).toBe("");
	expect(permissionVars(malformed).permission_message).toBe("");
});

// --- buildBody ---

test("buildBody: empty text falls back to generic message", () => {
	expect(buildBody("")).toBe("Task complete. Ready for input.");
	expect(buildBody("   \n  ")).toBe("Task complete. Ready for input.");
});

test("buildBody: short text becomes a quoted snippet", () => {
	expect(buildBody("fix the auth bug")).toBe('Done: "fix the auth bug"');
});

test("buildBody: collapses whitespace", () => {
	expect(buildBody("fix\n  the   bug")).toBe('Done: "fix the bug"');
});

test("buildBody: truncates text longer than 60 chars with ellipsis", () => {
	const long = "a".repeat(70);
	expect(buildBody(long)).toBe(`Done: "${"a".repeat(60)}…"`);
});

// --- buildTitle ---

test("buildTitle: no session name falls back to 'Pi Agent'", () => {
	expect(buildTitle(undefined)).toBe("Pi Agent");
});

test("buildTitle: session name is included in title", () => {
	expect(buildTitle("my-project")).toBe("Pi — my-project");
});

test("buildTitle: empty string falls back to folder or 'Pi Agent'", () => {
	expect(buildTitle("")).toBe("Pi Agent");
	expect(buildTitle("", "repo")).toBe("Pi (repo)");
});

test("buildTitle: folder is used when session name is missing", () => {
	expect(buildTitle(undefined, "pi-notify")).toBe("Pi (pi-notify)");
});

// --- resolveTemplates ---

test("resolveTemplates: replaces known placeholders", () => {
	expect(resolveTemplates("{folder} ready", { folder: "app" })).toBe("app ready");
});

test("resolveTemplates: leaves unknown placeholders intact", () => {
	expect(resolveTemplates("hello {missing}", {})).toBe("hello {missing}");
});

// --- sanitize ---

test("stripControlChars: removes BEL but keeps semicolon prose", () => {
	expect(stripControlChars("fix A;\x07 fix B")).toBe("fix A; fix B");
});

test("stripControlChars: strips C1 control characters too", () => {
	expect(stripControlChars("a\u0085b\u009Fc")).toBe("abc");
});

test("sanitizeOscText: strips controls and OSC separators", () => {
	expect(sanitizeOscText("hi;\x07there\n\tnow")).toBe("hi,there now");
});

test("sanitizeOscText: trims and collapses whitespace", () => {
	expect(sanitizeOscText("  a   b  ")).toBe("a b");
});

// --- resolveIconPath ---

test("resolveIconPath: finds logo.png next to the extension", () => {
	const icon = resolveIconPath("logo.png");
	expect(icon).toBeTruthy();
	expect(icon!.replaceAll("\\", "/").endsWith("logo.png")).toBe(true);
});

test("resolveIconPath: missing file returns undefined", () => {
	expect(resolveIconPath("definitely-missing-icon-xyz.png")).toBeUndefined();
});

// --- WSL detection ---

test("isWSL: recognizes WSL markers only on Linux", () => {
	expect(isWSL({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
	expect(isWSL({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux")).toBe(true);
	expect(isWSL({ WSL_DISTRO_NAME: "Ubuntu" }, "win32")).toBe(false);
	expect(isWSL({}, "linux")).toBe(false);
});

// --- windowsToastScript ---

test("windowsToastScript: uses a registered AppUserModelID", () => {
	const script = windowsToastScript("title", "body");
	expect(script).toContain("CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')");
	expect(script).not.toContain("CreateToastNotifier('Pi Agent')");
});

test("notifyWindows: falls back from Windows PowerShell to pwsh", () => {
	const savedDistro = process.env.WSL_DISTRO_NAME;
	process.env.WSL_DISTRO_NAME = "Ubuntu";
	const calls: Array<{ file: string; args: string[] }> = [];

	try {
		notifyWindows("title", "body", undefined, (file, args, callback) => {
			calls.push({ file, args });
			callback(file === "powershell.exe" ? new Error("not available") : null);
		});
	} finally {
		if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
		else process.env.WSL_DISTRO_NAME = savedDistro;
	}

	expect(calls.map(({ file }) => file)).toEqual(["powershell.exe", "pwsh.exe"]);
	expect(calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
});

// --- toastImageSrc ---

test("toastImageSrc: converts a Windows drive path to a file URI", () => {
	expect(toastImageSrc("D:\\apps\\pi-notify\\logo.png")).toBe("file:///D:/apps/pi-notify/logo.png");
});

test("toastImageSrc: converts a UNC path to a file URI", () => {
	expect(toastImageSrc("\\\\wsl$\\Ubuntu\\logo.png")).toBe("file://wsl$/Ubuntu/logo.png");
});

test("toastImageSrc: passes through an existing URI unchanged", () => {
	expect(toastImageSrc("file:///C:/logo.png")).toBe("file:///C:/logo.png");
});

// --- runHandlers ---

test("runHandlers: continues after a throwing handler", async () => {
	const seen: number[] = [];
	const origError = console.error;
	console.error = () => {};
	try {
		await runHandlers(
			[
				() => {
					seen.push(1);
					throw new Error("boom");
				},
				async () => {
					seen.push(2);
				},
			],
			null,
		);
	} finally {
		console.error = origError;
	}
	expect(seen).toEqual([1, 2]);
});

function createTestBus() {
	// 创建可观察的最小 EventBus 测试桩
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => channelListeners.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) {
				handler(data);
			}
		},
	};
	return {
		events,
		count(channel: string) {
			return listeners.get(channel)?.size ?? 0;
		},
	};
}

function createTestPi(bus: ReturnType<typeof createTestBus>) {
	// 构造最小化的 pi 测试桩
	const lifecycle = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
	const pi = {
		events: bus.events,
		getSessionName: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
			lifecycle.set(event, handler);
		},
	} as any;
	return { pi, lifecycle };
}

async function withIsolatedTransport(fn: (writes: unknown[][]) => Promise<void>): Promise<void> {
	// 隔离通知传输：屏蔽终端环境变量并捕获 stdout 写入
	const envKeys = [
		"WT_SESSION",
		"WSLENV",
		"WSL_DISTRO_NAME",
		"WSL_INTEROP",
		"KITTY_WINDOW_ID",
		"TERM_PROGRAM",
		"ITERM_SESSION_ID",
		"PI_NOTIFY_SOUND_CMD",
		"PI_NOTIFY_FOCUS_CMD",
		"PI_NOTIFY_PERMISSION_TITLE",
		"PI_NOTIFY_PERMISSION_BODY",
	] as const;
	const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
	for (const k of envKeys) delete process.env[k];

	const writes: unknown[][] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	(process.stdout.write as any) = (...args: unknown[]) => {
		writes.push(args);
		return true;
	};

	try {
		await fn(writes);
	} finally {
		(process.stdout.write as any) = origWrite;
		for (const k of envKeys) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	}
}

test("customization: bus hooks work without load-order coupling", async () => {
	const bus = createTestBus();
	const notification = { title: "base", body: "body", vars: {} };
	bus.events.on("pi-notify:customize", (data) => {
		(data as typeof notification).title = "legacy";
	});
	const off = registerCustomize({ events: bus.events } as any, async (data) => {
		await Promise.resolve();
		data.body = "awaited";
	});

	await applyCustomizations(bus.events as any, notification);

	expect(notification).toEqual({ title: "legacy", body: "awaited", vars: {} });
	off();
});

test("extension: pause during customization suppresses the pending send", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	registerExtension(pi);

	let emittedPause = false;
	registerCustomize({ events: bus.events } as any, async (notification) => {
		if (!emittedPause) {
			emittedPause = true;
			bus.events.emit("pi-notify:pause");
		}
		notification.body = "customized";
	});

	let fired = 0;
	bus.events.on("pi-notify:fired", () => {
		fired++;
	});

	await withIsolatedTransport(async (writes) => {
		bus.events.emit("pi-notify:send", { title: "T", body: "B" });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(0);
		expect(fired).toBe(0);

		bus.events.emit("pi-notify:unpause");
		bus.events.emit("pi-notify:send", { title: "T", body: "B" });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
		expect(fired).toBe(1);
	});
});

test("extension: session_start resets prompt state from the previous session", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	registerExtension(pi);

	const bodies: string[] = [];
	bus.events.on("pi-notify:fired", (n) => bodies.push((n as { body: string }).body));

	await withIsolatedTransport(async () => {
		await lifecycle.get("input")?.({ source: "interactive", text: "old prompt" } as any);
		bus.events.emit("pi-notify:send", { title: "T", body: "p:{prompt}" });
		await new Promise((r) => setTimeout(r, 0));
		expect(bodies[0]).toBe("p:old prompt");

		await lifecycle.get("session_start")?.({ type: "session_start" } as any, { cwd: process.cwd() });
		bus.events.emit("pi-notify:send", { title: "T", body: "p:{prompt}" });
		await new Promise((r) => setTimeout(r, 0));
		expect(bodies[1]).toBe("p:");
	});
});

test("extension: {prompt} var is capped in sends", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	registerExtension(pi);

	const bodies: string[] = [];
	bus.events.on("pi-notify:fired", (n) => bodies.push((n as { body: string }).body));

	await withIsolatedTransport(async () => {
		await lifecycle.get("input")?.({ source: "interactive", text: "x".repeat(800) } as any);
		bus.events.emit("pi-notify:send", { title: "T", body: "{prompt}" });
		await new Promise((r) => setTimeout(r, 0));
		expect(bodies[0]).toBe("x".repeat(500));
	});
});

test("extension: re-entrant send from a customizer does not recurse", async () => {
	const bus = createTestBus();
	const { pi } = createTestPi(bus);
	registerExtension(pi);

	registerCustomize({ events: bus.events } as any, () => {
		bus.events.emit("pi-notify:send", { title: "nested", body: "nested" });
	});

	let fired = 0;
	bus.events.on("pi-notify:fired", () => fired++);

	await withIsolatedTransport(async (writes) => {
		bus.events.emit("pi-notify:send", { title: "outer", body: "outer" });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
		expect(fired).toBe(1);
	});
});

test("extension: agent_settled sends once; cooldown suppresses a second settle", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	registerExtension(pi);

	await withIsolatedTransport(async (writes) => {
		await lifecycle.get("agent_settled")?.({ type: "agent_settled" } as any, { cwd: process.cwd() });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);

		await lifecycle.get("agent_settled")?.({ type: "agent_settled" } as any, { cwd: process.cwd() });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
	});
});

test("extension lifecycle: leaves EventBus methods intact and unsubscribes controls", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	const originalOn = bus.events.on;

	registerExtension(pi);

	expect(bus.events.on).toBe(originalOn);
	expect(bus.count("pi-notify:send")).toBe(1);
	expect(bus.count("permissions:ui_prompt")).toBe(1);
	await lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" });
	expect(bus.events.on).toBe(originalOn);
	expect(bus.count("pi-notify:send")).toBe(0);
	expect(bus.count("permissions:ui_prompt")).toBe(0);
});

test("extension: permissions:ui_prompt sends a notification with ask content", async () => {
	const bus = createTestBus();
	const { pi } = createTestPi(bus);
	registerExtension(pi);

	const fired: Array<{ title: string; body: string }> = [];
	bus.events.on("pi-notify:fired", (n) => fired.push(n as { title: string; body: string }));

	await withIsolatedTransport(async (writes) => {
		bus.events.emit("permissions:ui_prompt", permissionPrompt({ message: "Run it?" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
		expect(fired).toHaveLength(1);
		expect(fired[0].title).toBe("Pi PA (pi-notify)");
		expect(fired[0].body).toBe("bash: git status");
	});
});

test("extension: permission notify starts the cooldown for a following settle", async () => {
	const bus = createTestBus();
	const { pi, lifecycle } = createTestPi(bus);
	registerExtension(pi);

	await withIsolatedTransport(async (writes) => {
		bus.events.emit("permissions:ui_prompt", permissionPrompt({ message: "Approve?" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);

		await lifecycle.get("agent_settled")?.({ type: "agent_settled" } as any, { cwd: process.cwd() });
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
	});
});

test("extension: paused suppresses permission notifications", async () => {
	const bus = createTestBus();
	const { pi } = createTestPi(bus);
	registerExtension(pi);

	await withIsolatedTransport(async (writes) => {
		bus.events.emit("pi-notify:pause");
		bus.events.emit("permissions:ui_prompt", permissionPrompt({ message: "Approve?" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(0);

		bus.events.emit("pi-notify:unpause");
		bus.events.emit("permissions:ui_prompt", permissionPrompt({ message: "Approve?" }));
		await new Promise((r) => setTimeout(r, 0));
		expect(writes).toHaveLength(1);
	});
});

test("extension: PI_NOTIFY_PERMISSION_TITLE/BODY resolve permission vars", async () => {
	const bus = createTestBus();
	const { pi } = createTestPi(bus);
	registerExtension(pi);

	const savedTitle = process.env.PI_NOTIFY_PERMISSION_TITLE;
	const savedBody = process.env.PI_NOTIFY_PERMISSION_BODY;
	process.env.PI_NOTIFY_PERMISSION_TITLE = "Perm {permission_surface} — {folder}";
	process.env.PI_NOTIFY_PERMISSION_BODY = "{permission_value} by {permission_agent}|{permission_requester}";

	try {
		await withIsolatedTransport(async (writes) => {
			process.env.PI_NOTIFY_PERMISSION_TITLE = "Perm {permission_surface} — {folder}";
			process.env.PI_NOTIFY_PERMISSION_BODY = "{permission_value} by {permission_agent}|{permission_requester}";
			bus.events.emit(
				"permissions:ui_prompt",
				permissionPrompt({ agentName: "Coder", forwarding: { requesterAgentName: "Explore", requesterSessionId: "s" } }),
			);
			await new Promise((r) => setTimeout(r, 0));
			expect(writes).toHaveLength(1);
			const fired = writes[0][0] as string;
			expect(fired).toContain("Perm bash — ");
			expect(fired).toContain("git status by Coder|Explore");
		});
	} finally {
		if (savedTitle === undefined) delete process.env.PI_NOTIFY_PERMISSION_TITLE;
		else process.env.PI_NOTIFY_PERMISSION_TITLE = savedTitle;
		if (savedBody === undefined) delete process.env.PI_NOTIFY_PERMISSION_BODY;
		else process.env.PI_NOTIFY_PERMISSION_BODY = savedBody;
	}
});

// --- recordInput ---

test("recordInput: steer updates lastSteerAt", () => {
	const s = createState();
	recordInput(s, inputEvent({ streamingBehavior: "steer" }) as any, 1000);
	expect(s.lastSteerAt).toBe(1000);
});

test("recordInput: followUp does not replace the idle prompt", () => {
	const s = createState();
	recordInput(s, inputEvent({ text: "initial prompt" }) as any, 1000);
	recordInput(s, inputEvent({ text: "queued prompt", streamingBehavior: "followUp" }) as any, 2000);
	expect(s.lastIdlePromptText).toBe("initial prompt");
});

test("recordInput: idle prompt stores the text", () => {
	const s = createState();
	recordInput(s, inputEvent({ text: "do the thing" }) as any, 1000);
	expect(s.lastIdlePromptText).toBe("do the thing");
});

test("recordInput: non-interactive source is ignored", () => {
	const s = createState();
	recordInput(s, inputEvent({ text: "x", source: "extension" }) as any, 1000);
	expect(s.lastIdlePromptText).toBe("");
});

// --- shouldNotify ---

test("shouldNotify: recent steers suppress and never probes focus", () => {
	const s = createState();
	s.lastSteerAt = 1_000_000;
	let probed = false;
	const result = shouldNotify(s, 1_000_000 + ENGAGEMENT_MS - 1, () => {
		probed = true;
		return false;
	});
	expect(result).toBe(false);
	expect(probed).toBe(false);
});

test("shouldNotify: within cooldown suppresses and never probes focus", () => {
	const s = createState();
	s.lastNotifiedAt = 1_000_000;
	let probed = false;
	const result = shouldNotify(s, 1_000_000 + COOLDOWN_MS - 1, () => {
		probed = true;
		return false;
	});
	expect(result).toBe(false);
	expect(probed).toBe(false);
});

test("shouldNotify: focused terminal suppresses", () => {
	const s = createState();
	const result = shouldNotify(s, 1_000_000, () => true);
	expect(result).toBe(false);
});

test("shouldNotify: all clear returns true", () => {
	const s = createState();
	const result = shouldNotify(s, 1_000_000, () => false);
	expect(result).toBe(true);
});

test("shouldNotify: steer exactly ENGAGEMENT_MS ago allows notification", () => {
	const s = createState();
	s.lastSteerAt = 1_000_000;
	const result = shouldNotify(s, 1_000_000 + ENGAGEMENT_MS, () => false);
	expect(result).toBe(true);
});

test("shouldNotify: cooldown exactly COOLDOWN_MS ago allows notification", () => {
	const s = createState();
	s.lastNotifiedAt = 1_000_000;
	const result = shouldNotify(s, 1_000_000 + COOLDOWN_MS, () => false);
	expect(result).toBe(true);
});

test("tryReadRunnerBound: live runner reads pass through", () => {
	const result = tryReadRunnerBound(() => "C:\\work\\pi-notify");
	expect(result).toBe("C:\\work\\pi-notify");
});

test("tryReadRunnerBound: invalidated runner reads return undefined", () => {
	const staleRead = () => {
		throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	expect(tryReadRunnerBound(staleRead)).toBeUndefined();
});

test("tryReadRunnerBound: unrelated read errors are rethrown", () => {
	const failingRead = () => {
		throw new Error("boom");
	};
	expect(() => tryReadRunnerBound(failingRead)).toThrow("boom");
});
