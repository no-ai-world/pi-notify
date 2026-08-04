# Agent Guidelines for pi-notify

## What this project is

A Pi coding agent extension that sends desktop notifications when the agent finishes a task.
Single-file extension (`index.ts`) with pure testable logic, cross-platform notification delivery,
and extension-facing customize/send/pause APIs.

## Running tests

```bash
bun test
```

Expected: all tests pass.

## Key files

| File | Purpose |
|---|---|
| `index.ts` | The extension — delivery functions (OSC/Windows) + pure suppression logic + extension APIs |
| `index.test.ts` | Unit tests for pure exported functions |
| `logo.png` | Windows toast icon |
| `package.json` | `bun test` script + peer dependency on `@earendil-works/pi-coding-agent` |

## Architecture rules

- Delivery functions (`notifyOSC777`, `notifyOSC9`, `notifyOSC99`, `notifyWindows`, `wrapForTmux`, `runSoundHook`, `sendNotification`) stay side-effect focused and cross-platform.
- Pure exported functions (`createState`, `recordInput`, `shouldNotify`, `buildBody`, `buildTitle`, `resolveTemplates`, `sanitizeOscText`, `stripControlChars`, `runHandlers`) must remain side-effect-free / bus-free and testable without a pi runtime.
- Default notify path uses `agent_settled` (not `agent_end`) so retry/compaction/follow-up do not false-trigger. Do not add a redundant queued-follow-up gate to the settled path.
- Never replace or patch the shared `pi.events.on` / `emit` methods. Synchronous compatibility customizers use `pi.events.on("pi-notify:customize", ...)`; awaited customizers use the exported `registerCustomize(pi, handler)` API and unregister during `session_shutdown` (stale handlers persist across `/reload`).
- On `session_shutdown`, unsubscribe control-plane handlers; do not mutate the shared EventBus.
- `lastNotifiedAt` updates only after a notification is actually sent.
- `runHandlers` isolates per-handler errors.
- `isFocused()` shells out only via `PI_NOTIFY_FOCUS_CMD` (`execFileSync` + shell). Keep the command fast — it blocks the event loop synchronously (3s timeout).
- There is no build step. Pi loads `index.ts` directly via its TypeScript runtime.
- Keep package imports on `@earendil-works/pi-coding-agent` (not `@mariozechner/pi-coding-agent`).
- Do not reintroduce `demo.gif` / `demo.mp4` references.

## Commit conventions

- `feat:` for logic/behaviour changes
- `test:` for test-only changes
- `docs:` for README/AGENTS.md changes
- `fix:` for bug fixes
