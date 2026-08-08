/**
 * 负责 Pi agent 完成时的桌面通知扩展入口与对外 API
 *
 * Desktop notifications when the agent settles and is waiting for input.
 * Delivery: OSC 777/9/99, tmux passthrough, Windows toast (+ logo.png).
 * Policy: streaming-aware suppression, cooldown, optional focus hook, manual pause.
 * Extension API: customize/send/pause/unpause/fired, /notify, Ctrl+Shift+N.
 *
 * Templates in PI_NOTIFY_TITLE / PI_NOTIFY_BODY:
 *   {cwd} {folder} {prompt} {session}
 */

import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Shape of the object passed to the "pi-notify:customize" event. */
export interface PiNotifyCustomization {
	title: string;
	body: string;
	/** Template variables available for {placeholder} resolution. Handlers can add new keys. */
	vars: Record<string, string>;
}

/** Shape of the object emitted by the "pi-notify:fired" event after a notification is sent. */
export interface PiNotifyFired {
	title: string;
	body: string;
}

/** Shape of the object passed to the "pi-notify:send" event. All fields are optional. */
export interface PiNotifySend {
	title?: string;
	body?: string;
	/** Template variables for {placeholder} resolution. Merged with built-in vars. */
	vars?: Record<string, string>;
	/** If true, skip the sound hook for this notification. */
	silent?: boolean;
}

export type PiNotifyCustomizeHandler = (notification: PiNotifyCustomization) => void | Promise<void>;
type Unsubscribe = () => void;

interface CustomizeRegistry {
	handlersByBus: WeakMap<object, Set<PiNotifyCustomizeHandler>>;
}

const CUSTOMIZE_REGISTRY_KEY = Symbol.for("pi-notify.customize-registry");

function getCustomizeRegistry(): CustomizeRegistry {
	// 获取跨模块共享的通知定制注册表
	const scope = globalThis as unknown as { [key: symbol]: CustomizeRegistry | undefined };
	return (scope[CUSTOMIZE_REGISTRY_KEY] ??= { handlersByBus: new WeakMap() });
}

function getCustomizeHandlers(events: ExtensionAPI["events"]): Set<PiNotifyCustomizeHandler> {
	// 获取指定 EventBus 的定制处理器集合
	const registry = getCustomizeRegistry();
	const bus = events as object;
	let handlers = registry.handlersByBus.get(bus);
	if (!handlers) {
		handlers = new Set();
		registry.handlersByBus.set(bus, handlers);
	}
	return handlers;
}

/** Register an awaited notification customizer for a Pi event bus. */
export function registerCustomize(
	pi: Pick<ExtensionAPI, "events">,
	handler: PiNotifyCustomizeHandler,
): Unsubscribe {
	// 注册可等待的通知定制处理器
	const registry = getCustomizeRegistry();
	const bus = pi.events as object;
	const handlers = getCustomizeHandlers(pi.events);
	handlers.add(handler);
	return () => {
		handlers.delete(handler);
		if (handlers.size === 0) registry.handlersByBus.delete(bus);
	};
}

export const COOLDOWN_MS = 30_000;
export const ENGAGEMENT_MS = 15_000;

/** Cap for the {prompt} template var, keeping toast command lines within Windows limits. */
const PROMPT_VAR_MAX = 500;

/** Cap for permission notification body text, keeping toasts compact. */
export const PERMISSION_BODY_MAX = 160;

/**
 * Shape of the `permissions:ui_prompt` event broadcast by
 * `@gotgenes/pi-permission-system` right before it shows its ask dialog.
 *
 * Local structural copy: that package is an optional runtime dependency, so
 * pi-notify never imports from it. Fields are read defensively instead.
 */
export interface PermissionUiPromptEvent {
	/** Unique ID for the permission request being prompted. */
	requestId: string;
	/** Prompt origin: tool call, or skill input/read. */
	source: "tool_call" | "skill_input" | "skill_read";
	/** Normalized display surface (e.g. "bash", "skill", tool name). */
	surface: string | null;
	/** Normalized display value (command, path, skill name, …). */
	value: string | null;
	/** Agent that requested the permission, when known. */
	agentName: string | null;
	/** Message shown in the permission dialog. */
	message: string;
	/** Forwarding context for a subagent ask; null for a direct prompt. */
	forwarding: { requesterAgentName: string | null; requesterSessionId: string | null } | null;
}

export interface NotifyState {
	/** Most recent idle interactive prompt text, used for notification context. */
	lastIdlePromptText: string;
	/** Timestamp (ms) of the most recent mid-stream steer. */
	lastSteerAt: number;
	/** Timestamp (ms) of the last notification we actually sent. */
	lastNotifiedAt: number;
}

// ── Path / sanitize helpers ───────────────────────────────────────────────────

/** Strip C0/C1 controls that break terminal streams. */
export function stripControlChars(text: string): string {
	// 移除通知文本中的 C0/C1 控制字符
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/** OSC payload sanitizer: controls + `;` (OSC field separator) + whitespace collapse. */
export function sanitizeOscText(text: string): string {
	// 清理写入 OSC 序列的通知文本
	return stripControlChars(text).replace(/;/g, ",").replace(/\s+/g, " ").trim();
}

/** Convert a local icon path to a toast-ready `file://` URI. */
export function toastImageSrc(localPath: string): string {
	// 将本地图标路径转换为 Windows toast 可用的 file URI
	const withSlashes = localPath.replace(/\\/g, "/");
	if (/^[a-z]+:\/\//i.test(withSlashes)) return withSlashes;
	if (withSlashes.startsWith("//")) return `file:${withSlashes}`;
	return `file:///${withSlashes}`;
}

function extensionDirCandidates(): string[] {
	// 收集扩展自身所在目录候选（不含 cwd，避免误用项目内同名 logo）
	const dirs: string[] = [];
	try {
		dirs.push(path.dirname(fileURLToPath(import.meta.url)));
	} catch {
		// jiti / non-file import.meta — ignore
	}
	const cjsDir = (globalThis as { __dirname?: string }).__dirname;
	if (cjsDir) dirs.push(cjsDir);
	return [...new Set(dirs)];
}

function isWSL(): boolean {
	// 判断当前是否运行在 WSL
	return Boolean(process.env.WSLENV) || (process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME));
}

export function resolveIconPath(iconRelative: string = "logo.png"): string | undefined {
	// 解析 Windows toast 图标的本机路径
	let localPath: string | undefined;
	for (const dir of extensionDirCandidates()) {
		const candidate = path.resolve(dir, iconRelative);
		if (existsSync(candidate)) {
			localPath = candidate;
			break;
		}
	}
	if (!localPath) return undefined;

	if (isWSL()) {
		try {
			return execFileSync("wslpath", ["-w", localPath], { encoding: "utf8" }).trim();
		} catch {
			return localPath;
		}
	}

	return localPath;
}

function escapePowerShellSingleQuoted(value: string): string {
	// 转义 PowerShell 单引号字符串
	return value.replace(/'/g, "''");
}

// ── Notification transport ────────────────────────────────────────────────────

function windowsToastScript(title: string, body: string, iconPath: string = ""): string {
	// 生成 Windows toast 的 PowerShell 脚本
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const templateType = iconPath ? "ToastImageAndText02" : "ToastText02";
	const template = `[${type}.ToastTemplateType]::${templateType}`;
	const safeTitle = escapePowerShellSingleQuoted(title);
	const safeBody = escapePowerShellSingleQuoted(body);

	const script = [
		`${mgr} | Out-Null`,
		`$t = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$t1 = $t.SelectSingleNode('//text[1]')`,
		`$t2 = $t.SelectSingleNode('//text[2]')`,
		`$t1.AppendChild($t.CreateTextNode('${safeTitle}')) | Out-Null`,
		`$t2.AppendChild($t.CreateTextNode('${safeBody}')) | Out-Null`,
	];

	if (iconPath) {
		const safeIconPath = escapePowerShellSingleQuoted(toastImageSrc(iconPath));
		script.push(`$i = $t.SelectSingleNode('//image')`);
		script.push(`$i.SetAttribute('src', '${safeIconPath}') | Out-Null`);
	}

	script.push(
		`[${type}.ToastNotificationManager]::CreateToastNotifier('Pi Agent').Show([${type}.ToastNotification]::new($t))`,
	);

	return script.join("; ");
}

function wrapForTmux(sequence: string): string {
	// 在 tmux 下包装 OSC 透传序列
	if (!process.env.TMUX) return sequence;
	const escaped = sequence.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
	// 通过 OSC 777 发送通知
	const sequence = `\x1b]777;notify;${title};${body}\x07`;
	process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
	// 通过 OSC 9 发送通知
	const sequence = `\x1b]9;${message}\x07`;
	process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
	// 通过 OSC 99 发送 Kitty 通知
	const titleSequence = `\x1b]99;i=1:d=0;${title}\x1b\\`;
	const bodySequence = `\x1b]99;i=1:p=body;${body}\x1b\\`;
	process.stdout.write(wrapForTmux(titleSequence));
	process.stdout.write(wrapForTmux(bodySequence));
}

function notifyWindows(title: string, body: string, iconPath?: string): void {
	// 通过 PowerShell toast 发送 Windows 通知
	const args = ["-NoProfile", "-Command", windowsToastScript(title, body, iconPath ?? "")];

	// WSL interop needs the .exe suffix; plain Windows resolves either way.
	const pwshBinary = process.platform === "win32" || isWSL() ? "pwsh.exe" : "pwsh";

	// Try pwsh first; fall back to Windows PowerShell. Only surface a single
	// error when both fail, so a broken toast doesn't spam the session log.
	execFile(pwshBinary, args, (pwshErr) => {
		if (!pwshErr) return;
		execFile("powershell.exe", args, (psErr) => {
			if (psErr) console.error("pi-notify windows toast failed (pwsh + powershell.exe):", psErr);
		});
	});
}

function runSoundHook(): void {
	// 运行可选的自定义声音钩子
	const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
	if (!command) return;

	try {
		const child = spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// Ignore hook errors to avoid breaking notifications
	}
}

function sendNotification(title: string, body: string, iconPath?: string): void {
	// 按终端环境选择通知投递通道
	const isIterm2 = process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);

	if (process.env.WT_SESSION) {
		// Toast text is PowerShell-escaped; only strip controls, keep ';' in prose.
		const winTitle = stripControlChars(title).replace(/\s+/g, " ").trim() || "Pi";
		const winBody = stripControlChars(body).replace(/\s+/g, " ").trim() || "Ready for input";
		notifyWindows(winTitle, winBody, iconPath);
		return;
	}

	const oscTitle = sanitizeOscText(title) || "Pi";
	const oscBody = sanitizeOscText(body) || "Ready for input";

	if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(oscTitle, oscBody);
	} else if (isIterm2) {
		notifyOSC9(`${oscTitle}: ${oscBody}`);
	} else {
		notifyOSC777(oscTitle, oscBody);
	}
}

/** Replace {key} placeholders with values from vars. Unknown placeholders are left as-is. */
export function resolveTemplates(text: string, vars: Record<string, string>): string {
	// 解析通知文本中的模板占位符
	return text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ── Streaming-aware suppression ───────────────────────────────────────────────

export function createState(): NotifyState {
	// 创建通知抑制状态
	return {
		lastIdlePromptText: "",
		lastSteerAt: 0,
		lastNotifiedAt: 0,
	};
}

/** Update engagement state from an input event. Only interactive input counts. */
export function recordInput(state: NotifyState, event: InputEvent, now: number): void {
	// 根据输入事件更新参与度状态
	if (event.source !== "interactive") return;
	if (event.streamingBehavior === "steer") {
		state.lastSteerAt = now;
	} else if (event.streamingBehavior === undefined) {
		state.lastIdlePromptText = event.text;
	}
}

/**
 * Decide whether to notify when the agent has settled. Cheap checks run first;
 * isFocused() (which may shell out) is only invoked if nothing else suppresses.
 */
export function shouldNotify(state: NotifyState, now: number, isFocused: () => boolean): boolean {
	// 判断 agent_settled 是否应发送通知
	if (now - state.lastSteerAt < ENGAGEMENT_MS) return false;
	if (now - state.lastNotifiedAt < COOLDOWN_MS) return false;
	if (isFocused()) return false;
	return true;
}

/** Build the default notification body from the most recent idle prompt. */
export function buildBody(promptText: string): string {
	// 根据最近空闲提示构建默认通知正文
	const cleaned = promptText.trim().replace(/\s+/g, " ");
	if (!cleaned) return "Task complete. Ready for input.";
	const snippet = cleaned.length > 60 ? cleaned.slice(0, 60) + "…" : cleaned;
	return `Done: "${snippet}"`;
}

/** Build the default notification title, including session name when available. */
export function buildTitle(sessionName: string | undefined, folder?: string): string {
	// 根据会话名与项目目录构建默认通知标题
	if (sessionName) return `Pi — ${sessionName}`;
	if (folder) return `Pi (${folder})`;
	return "Pi Agent";
}

/** True when the payload looks like a `permissions:ui_prompt` broadcast. */
export function isPermissionUiPrompt(data: unknown): data is PermissionUiPromptEvent {
	// 防御性识别权限提示广播载荷
	if (typeof data !== "object" || data === null) return false;
	const event = data as Partial<PermissionUiPromptEvent>;
	return (
		typeof event.requestId === "string" ||
		typeof event.message === "string" ||
		typeof event.surface === "string" ||
		typeof event.value === "string"
	);
}

function truncateText(text: string, max: number): string {
	// 截断长文本并保留省略号
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

/** Build the default notification title for a permission prompt. */
export function buildPermissionTitle(
	event: PermissionUiPromptEvent,
	sessionName?: string,
	folder?: string,
): string {
	// 根据权限提示构建默认通知标题（who → session → folder 兜底链）
	const who = event.forwarding?.requesterAgentName ?? event.agentName;
	const base = who ? `Pi PA (${who})` : "Pi PA";
	if (sessionName) return `${base} — ${sessionName}`;
	if (folder) return `${base} (${folder})`;
	return base;
}

/**
 * Strip dialog-oriented prose from a permission ask message, keeping the
 * factual core: removes the subject preamble ("Current agent requested …"),
 * the trailing allow-question ("… Allow this command?"), and matched-rule
 * noise from the permission system's internal patterns.
 */
export function cleanPermissionMessage(raw: unknown): string {
	// 清洗权限对话框散文，保留事实部分（主语前缀/提问后缀/内部规则噪音）
	if (typeof raw !== "string") return "";
	let text = raw.trim();
	if (!text) return "";
	text = text
		.replace(/^(?:current agent|agent '[^']*'|subagent(?: '[^']*')?)\s+requested\s+(?:access to\s+)?/i, "")
		.replace(/\(matched ?'[^']*'\)\s*/g, "")
		.replace(/\s*\.\s*Allow [^.]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	return text;
}

/** Build the default notification body for a permission prompt. */
export function buildPermissionBody(event: PermissionUiPromptEvent): string {
	// 优先 surface:value 紧凑呈现，message 清洗后兜底（跨扩展载荷，字段防御性读取）
	const surface = typeof event.surface === "string" ? event.surface.trim() : "";
	const value = typeof event.value === "string" ? event.value.trim() : "";
	if (value) {
		const label = surface || "permission";
		if (label !== value) {
			const budget = Math.max(1, PERMISSION_BODY_MAX - label.length - 2);
			return `${label}: ${truncateText(value, budget)}`;
		}
	}
	const message = cleanPermissionMessage(event.message);
	if (message) return truncateText(message, PERMISSION_BODY_MAX);
	return "A permission decision is required.";
}

/** Template variables exposed for permission notifications. */
export function permissionVars(event: PermissionUiPromptEvent): Record<string, string> {
	// 组装权限提示可用的模板变量（跨扩展载荷，字段防御性读取）
	return {
		permission_surface: typeof event.surface === "string" ? event.surface : "",
		permission_value: (typeof event.value === "string" ? event.value : "").slice(0, PROMPT_VAR_MAX),
		permission_message: (typeof event.message === "string" ? event.message : "").slice(0, PROMPT_VAR_MAX),
		permission_agent: typeof event.agentName === "string" ? event.agentName : "",
		permission_requester:
			typeof event.forwarding?.requesterAgentName === "string" ? event.forwarding.requesterAgentName : "",
	};
}

/**
 * Returns true if the terminal is currently focused.
 * Runs PI_NOTIFY_FOCUS_CMD as a shell command; exit 0 means focused (suppress).
 * If the env var is unset, always returns false (never suppress based on focus).
 */
function isFocused(): boolean {
	// 通过可选焦点命令检测终端是否前台
	const cmd = process.env.PI_NOTIFY_FOCUS_CMD?.trim();
	if (!cmd) return false;
	try {
		if (process.platform === "win32") {
			execFileSync("cmd.exe", ["/d", "/s", "/c", cmd], { timeout: 3000, stdio: "ignore" });
		} else {
			execFileSync("sh", ["-c", cmd], { timeout: 3000, stdio: "ignore" });
		}
		return true;
	} catch {
		return false;
	}
}

function builtInVars(options: {
	cwd: string;
	sessionName?: string;
	promptText?: string;
	extra?: Record<string, string>;
}): Record<string, string> {
	// 组装内置模板变量
	const folder = path.basename(options.cwd);
	return {
		cwd: options.cwd,
		folder,
		prompt: (options.promptText ?? "").slice(0, PROMPT_VAR_MAX),
		session: options.sessionName ?? "",
		...options.extra,
	};
}

export async function runHandlers<T>(
	handlers: Array<(payload: T) => void | Promise<void>>,
	payload: T,
): Promise<void> {
	// 依次执行事件处理器；单个失败不影响其余
	for (const handler of handlers) {
		try {
			await handler(payload);
		} catch (err) {
			console.error("pi-notify handler error:", err);
		}
	}
}

/**
 * Prefix of the error thrown by an extension runner invalidated by a session replacement or reload.
 * Keep in sync with the pi bump: a reworded message makes stale reads fail loud again.
 */
const STALE_CTX_PREFIX = "This extension ctx is stale after session replacement or reload";

/**
 * Read a runner-bound value that may be unavailable: a session replacement or
 * reload invalidates the extension runner, so its ctx/api reads throw a known
 * stale-ctx error. Returns undefined for that exact error so handlers can skip
 * or degrade cleanly; any other error is rethrown to stay visible.
 */
export function tryReadRunnerBound<T>(read: () => T): T | undefined {
	// 仅放行会话替换/重载导致的已知 stale 错误，其余读取错误照抛
	try {
		return read();
	} catch (err) {
		if (err instanceof Error && err.message.startsWith(STALE_CTX_PREFIX)) return undefined;
		throw err;
	}
}

/** Apply legacy synchronous bus hooks and awaited registered customizers. */
export async function applyCustomizations(
	events: ExtensionAPI["events"],
	notification: PiNotifyCustomization,
): Promise<void> {
	// 应用兼容事件钩子与显式注册的异步定制器
	events.emit("pi-notify:customize", notification);
	await runHandlers([...getCustomizeHandlers(events)], notification);
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// 注册 pi-notify 生命周期钩子与扩展 API
	let state = createState();
	let paused = false;
	let sending = false;
	let latestCwd = process.cwd();
	let statusUi: ExtensionContext["ui"] | undefined;
	let disposed = false;
	const unsubscribers: Unsubscribe[] = [];

	function updateStatus(ui: ExtensionContext["ui"] | undefined = statusUi): void {
		// 更新底部通知开关状态
		if (!ui) return;
		statusUi = ui;
		ui.setStatus("pi-notify", paused ? "🔕 notify: off" : "🔔 notify: on");
	}

	function setPaused(nextPaused: boolean): void {
		// 更新暂停状态、footer，并广播事件
		if (disposed || paused === nextPaused) return;
		paused = nextPaused;
		updateStatus();
		pi.events.emit("pi-notify:paused", { paused });
	}

	async function notify(
		rawTitle: string,
		rawBody: string,
		baseVars: Record<string, string>,
		options?: { silent?: boolean },
	): Promise<boolean> {
		// 发送经过模板解析与扩展钩子处理后的通知
		// Re-entrancy guard: a customize/fired handler that emits pi-notify:send
		// must not recurse into another send while this one is in flight.
		if (disposed || paused || sending) return false;
		sending = true;
		try {
			const notification: PiNotifyCustomization = {
				title: rawTitle,
				body: rawBody,
				vars: { ...baseVars },
			};

			// Legacy bus handlers stay synchronous; explicit customizers are awaited.
			await applyCustomizations(pi.events, notification);
			if (disposed || paused) return false;

			const title = resolveTemplates(notification.title, notification.vars);
			const body = resolveTemplates(notification.body, notification.vars);

			// Resolve per send so late-added logos (or WSL state changes) take effect without a reload.
			sendNotification(title, body, resolveIconPath("logo.png"));

			if (!options?.silent) {
				runSoundHook();
			}

			pi.events.emit("pi-notify:fired", { title, body } satisfies PiNotifyFired);
			return true;
		} finally {
			sending = false;
		}
	}

	async function handleSend(msg: PiNotifySend): Promise<void> {
		// 处理扩展触发的主动通知
		if (disposed) return;

		const sessionName = tryReadRunnerBound(() => pi.getSessionName());
		const cwd = latestCwd || process.cwd();
		const folder = path.basename(cwd);
		const vars = builtInVars({
			cwd,
			sessionName,
			promptText: state.lastIdlePromptText,
			extra: msg.vars,
		});

		const sent = await notify(
			msg.title ?? process.env.PI_NOTIFY_TITLE ?? buildTitle(sessionName, folder),
			msg.body ?? "Notification",
			vars,
			{ silent: msg.silent },
		);
		if (sent) {
			state.lastNotifiedAt = Date.now();
		}
	}

	async function handlePermissionPrompt(data: unknown): Promise<void> {
		// 处理权限系统广播的待确认提示
		if (disposed || paused) return;
		if (!isPermissionUiPrompt(data)) return;
		if (isFocused()) return; // the ask dialog is already visible to the user

		const sessionName = tryReadRunnerBound(() => pi.getSessionName());
		const cwd = latestCwd || process.cwd();
		const folder = path.basename(cwd);
		const vars = {
			...builtInVars({ cwd, sessionName, promptText: state.lastIdlePromptText }),
			...permissionVars(data),
		};

		const sent = await notify(
			process.env.PI_NOTIFY_PERMISSION_TITLE ?? buildPermissionTitle(data, sessionName, folder),
			process.env.PI_NOTIFY_PERMISSION_BODY ?? buildPermissionBody(data),
			vars,
		);
		if (sent) {
			// Start the cooldown so the settle after the user approves does not
			// double-notify; each ask itself bypasses the cooldown gate.
			state.lastNotifiedAt = Date.now();
		}
	}

	function toggleNotifications(ctx: ExtensionContext): void {
		// 切换通知开关并反馈 UI
		statusUi = ctx.ui;
		setPaused(!paused);
		ctx.ui.notify(paused ? "Notifications paused 🔕" : "Notifications enabled 🔔", "info");
	}

	function track(off: Unsubscribe): void {
		// 记录可在 shutdown 时注销的订阅
		unsubscribers.push(off);
	}

	// Control-plane channels stay on the real shared bus (no emit patch).
	track(
		pi.events.on("pi-notify:pause", () => {
			setPaused(true);
		}),
	);
	track(
		pi.events.on("pi-notify:unpause", () => {
			setPaused(false);
		}),
	);
	track(
		pi.events.on("pi-notify:send", (data) => {
			void handleSend(data as PiNotifySend).catch((err) => {
				console.error("pi-notify:send failed:", err);
			});
		}),
	);

	// @gotgenes/pi-permission-system broadcasts `permissions:ui_prompt` right
	// before showing its ask dialog; ping the user that the agent is waiting
	// on a decision. No hard dependency: without that package installed, no
	// events fire and this listener stays inert.
	track(
		pi.events.on("permissions:ui_prompt", (data) => {
			void handlePermissionPrompt(data).catch((err) => {
				console.error("pi-notify permissions:ui_prompt failed:", err);
			});
		}),
	);

	pi.registerCommand("notify", {
		description: "Toggle desktop notifications on/off",
		handler: async (_args, ctx) => {
			toggleNotifications(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+n", {
		description: "Toggle desktop notifications on/off",
		handler: async (ctx) => {
			toggleNotifications(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCwd = ctx.cwd;
		// Fresh session: drop prompt/steer/cooldown state from the previous session.
		state = createState();
		updateStatus(ctx.ui);
	});

	pi.on("session_shutdown", async () => {
		// 注销 bus 订阅，防止 reload/switch 泄漏
		if (disposed) return;
		disposed = true;
		for (const off of unsubscribers.splice(0)) {
			try {
				off();
			} catch {
				// Ignore unsubscribe errors during teardown
			}
		}
		statusUi = undefined;
	});

	pi.on("input", async (event) => {
		recordInput(state, event, Date.now());
		return { action: "continue" as const };
	});

	// agent_settled = no retry / compaction / queued follow-up left (true idle).
	pi.on("agent_settled", async (_event, ctx) => {
		// A session replacement (newSession/fork/switchSession/reload) invalidates
		// the runner mid-run; the leftover settled event then throws on ctx reads.
		// The user is actively switching sessions, so the notification is noise.
		const cwd = tryReadRunnerBound(() => ctx.cwd);
		if (cwd === undefined) return;
		latestCwd = cwd;
		const sessionName = tryReadRunnerBound(() => pi.getSessionName());

		const now = Date.now();
		if (!shouldNotify(state, now, isFocused)) return;

		const folder = path.basename(cwd);
		const vars = builtInVars({
			cwd,
			sessionName,
			promptText: state.lastIdlePromptText,
		});

		const sent = await notify(
			process.env.PI_NOTIFY_TITLE ?? buildTitle(sessionName, folder),
			process.env.PI_NOTIFY_BODY ?? buildBody(state.lastIdlePromptText),
			vars,
		);
		if (sent) {
			state.lastNotifiedAt = Date.now();
		}
	});
}
