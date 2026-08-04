# pi-notify

A [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that sends a native desktop notification when the agent finishes and is waiting for input.

## Compatibility

| Terminal                       | Support | Protocol                        |
| ------------------------------ | ------- | ------------------------------- |
| Ghostty                        | ✓       | OSC 777                         |
| iTerm2                         | ✓       | OSC 9                           |
| WezTerm                        | ✓       | OSC 777                         |
| rxvt-unicode                   | ✓       | OSC 777                         |
| Kitty                          | ✓       | OSC 99                          |
| tmux (inside a supported term) | ✓*      | tmux passthrough + OSC 777/99/9 |
| Windows Terminal               | ✓       | PowerShell toast (+ icon)       |
| Terminal.app                   | ✗       | —                               |
| Alacritty                      | ✗       | —                               |

\* tmux requires passthrough enabled in your tmux config:

```tmux
set -g allow-passthrough on
```

## Install

```bash
pi install npm:pi-notify
```

Or via git:

```bash
pi install git:github.com/no-ai-world/pi-notify
```

Restart Pi.

## How it works

When Pi fully settles (`agent_settled` — no retry, compaction, or queued follow-up left), the extension checks suppression signals and — if notification is warranted — sends a notification via the appropriate protocol:

- **OSC 777** (Ghostty, WezTerm, rxvt-unicode): Native escape sequence
- **OSC 9** (iTerm2): iTerm2 notification protocol, detected via `TERM_PROGRAM=iTerm.app`
- **OSC 99** (Kitty): Kitty's notification protocol, detected via `KITTY_WINDOW_ID`
- **tmux passthrough**: OSC sequences are wrapped automatically when `TMUX` is set
- **Windows toast** (Windows Terminal via `WT_SESSION`): PowerShell notification with `logo.png` when resolvable beside the extension

Clicking the notification focuses the terminal window/tab.

## Notification content

Default content (overridable via env vars / extension hooks):

- **Title:** `Pi — <session name>` when a Pi session name is set, otherwise `Pi (<folder>)`, otherwise `Pi Agent`
- **Body:** `Done: "your last prompt"` (truncated to 60 characters), or `Task complete. Ready for input.` if no prompt text is available

## Smart suppression

The extension suppresses notifications to avoid noise. Checks run cheapest-first:

| Signal | Threshold | Reason |
| --- | --- | --- |
| Recent steer | 15 seconds | User sent a mid-stream message — they are present |
| Cooldown | 30 seconds | Deduplicates rapid back-to-back completions |
| Focus detection | `PI_NOTIFY_FOCUS_CMD` exit 0 | Terminal is frontmost — user is already watching |
| Manual pause | `/notify` or `Ctrl+Shift+N` | User disabled notifications |

## User controls

- `/notify` — toggle desktop notifications on/off
- `Ctrl+Shift+N` — same toggle via shortcut
- Footer status shows `🔔 notify: on` / `🔕 notify: off`
- Pause state is per session — it resets when you switch sessions or reload extensions

## Pausing notifications from other extensions

```typescript
pi.events.emit("pi-notify:pause");
pi.events.emit("pi-notify:unpause");

pi.events.on("pi-notify:paused", ({ paused }) => {
    console.log(paused ? "Notifications paused" : "Notifications resumed");
});
```

This suppresses both the default `agent_settled` notification and notifications triggered via `pi-notify:send`.

## Customizing title & body

### Environment variables

```bash
export PI_NOTIFY_TITLE="Pi ({folder})"
export PI_NOTIFY_BODY="Done in {folder}: {prompt}"
```

### Template placeholders

| Placeholder | Value |
| ----------- | ----- |
| `{cwd}`     | Full working directory path |
| `{folder}`  | Basename of the working directory |
| `{prompt}`  | Last idle interactive prompt text |
| `{session}` | Pi session name (empty when unset) |

Unknown placeholders are left as-is. `{prompt}` is capped at 500 characters; extra `vars` passed to `pi-notify:send` override the built-ins (`{cwd}`, `{folder}`, `{prompt}`, `{session}`).

### Dynamic customization from other extensions

Use the explicit registration API when customization may be asynchronous; it is independent of extension load order and is awaited before delivery:

```typescript
import { registerCustomize } from "pi-notify";

export default function (pi: ExtensionAPI) {
    const unregister = registerCustomize(pi, async (notification) => {
        notification.title = "My Project";
        notification.body = "{folder} on {branch} — done!";
        notification.vars.branch = await getCurrentGitBranch();
    });

    pi.on("session_shutdown", async () => unregister());
}
```

The shared event bus remains available for simple synchronous customizers:

```typescript
pi.events.on("pi-notify:customize", (notification) => {
    notification.title = "My Project";
    notification.body = "{folder} done!";
});
```

Do not register the same handler through both APIs. The explicit API is required when mutations happen after an `await`.

```typescript
interface PiNotifyCustomization {
    title: string;
    body: string;
    vars: Record<string, string>;
}
```

**Execution order:**
1. Pause check — if paused, the notification is suppressed
2. Defaults are read from `PI_NOTIFY_TITLE` / `PI_NOTIFY_BODY` (or built-in title/body helpers)
3. Built-in vars (`cwd`, `folder`, `prompt`, `session`) are populated
4. Synchronous `pi-notify:customize` bus handlers run
5. `registerCustomize` handlers run to completion (awaited)
6. `{placeholder}` templates are resolved
7. Text is sanitized for the active transport (OSC strips `;` / controls; Windows toast only strips controls)
8. Notification is sent
9. `pi-notify:fired` is emitted on the shared event bus

> Notes on the extension bus:
> - pi-notify never replaces `events.on` or `events.emit`; other extensions keep the original bus behavior.
> - Event-bus customizers must mutate synchronously. Use `registerCustomize(pi, handler)` for awaited customization.
> - `registerCustomize` is keyed to the current Pi event bus and returns an unregister function; call it from `session_shutdown`.
> - Registered customizers live for the lifetime of the Pi process — after `/reload` they are **not** cleared automatically, so always unregister them in `session_shutdown` (or a reload handler).
> - `pause` / `unpause` / `send` / `fired` / `paused` use the normal shared bus.

### Sending notifications from other extensions

```typescript
pi.events.emit("pi-notify:send", {
    title: "My Extension",
    body: "Build finished in {folder}!",
});

pi.events.emit("pi-notify:send", {
    title: "Deploy",
    body: "{env} deploy complete ({duration}s)",
    vars: { env: "production", duration: "42" },
    silent: true,
});
```

```typescript
interface PiNotifySend {
    title?: string;
    body?: string;
    vars?: Record<string, string>;
    silent?: boolean;
}
```

A manual send also starts the 30s cooldown, so an `agent_settled` notification right after it is suppressed.

## Optional: Custom sound hook

Set `PI_NOTIFY_SOUND_CMD` to run a custom command whenever a notification is sent.

> Note: This is an additional sound hook. It does not replace native terminal/system notification sounds.

### Example (macOS)

```fish
set -Ux PI_NOTIFY_SOUND_CMD 'afplay ~/Library/Sounds/Glass.aiff'
```

### Example (Linux)

```bash
export PI_NOTIFY_SOUND_CMD='paplay /usr/share/sounds/freedesktop/stereo/complete.oga'
```

### Example (Windows PowerShell)

```powershell
$env:PI_NOTIFY_SOUND_CMD = 'powershell -NoProfile -Command "[console]::beep(880,180)"'
```

The command is run in the background (`shell: true`, detached) so it won't block Pi.

## Optional: Focus suppression

Set `PI_NOTIFY_FOCUS_CMD` to a shell command that exits **0 when your terminal is frontmost**. When it exits 0, the notification is suppressed.

### Example (macOS)

```fish
set -Ux PI_NOTIFY_FOCUS_CMD \
  "osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true' | grep -qE 'iTerm2|Ghostty|kitty|Terminal'"
```

### Example (Linux)

```bash
export PI_NOTIFY_FOCUS_CMD='xdotool getactivewindow getwindowname | grep -qiE "terminal|kitty|alacritty"'
```

If `PI_NOTIFY_FOCUS_CMD` is unset, focus detection is skipped and the cooldown + recent-steer signal alone gate notifications.

> Keep the command fast: it runs **synchronously** at settle time and blocks Pi for up to its 3-second timeout.

## What's OSC 777/99/9?

OSC = Operating System Command, part of ANSI escape sequences. Terminals use these for things beyond text formatting (change title, colors, notifications, etc.).

`777` is the number rxvt-unicode picked for notifications. Ghostty and WezTerm adopted it. iTerm2 uses `9` instead, and Kitty uses `99` with a more extensible protocol.

## Known Limitations

- **tmux** works only with passthrough enabled (`set -g allow-passthrough on`).
- **zellij/screen** are still unsupported for OSC notifications.

## License

MIT
