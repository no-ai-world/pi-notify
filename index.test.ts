// 验证 pi-notify 纯函数通知决策与模板逻辑

import { test, expect } from "bun:test";
import registerExtension, {
	applyCustomizations,
	createState,
	recordInput,
	shouldNotify,
	buildBody,
	buildTitle,
	resolveTemplates,
	sanitizeOscText,
	stripControlChars,
	resolveIconPath,
	toastImageSrc,
	runHandlers,
	registerCustomize,
	ENGAGEMENT_MS,
	COOLDOWN_MS,
} from "./index.ts";

// Minimal InputEvent stub — avoids importing from @earendil-works/pi-coding-agent at test time
type InputEvent = { source: string; text: string; streamingBehavior?: "steer" | "followUp" };

function inputEvent(partial: Partial<InputEvent>): InputEvent {
	// 构造最小化的输入事件桩
	return { source: "interactive", text: "", ...partial };
}

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
		"KITTY_WINDOW_ID",
		"TERM_PROGRAM",
		"ITERM_SESSION_ID",
		"PI_NOTIFY_SOUND_CMD",
		"PI_NOTIFY_FOCUS_CMD",
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
	await lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" });
	expect(bus.events.on).toBe(originalOn);
	expect(bus.count("pi-notify:send")).toBe(0);
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
