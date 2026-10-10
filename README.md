# bb-plugin-auto-compact

Automatically compacts a thread's context window when usage reaches a
configurable percentage (default 80%).

- `server.ts` — the backend: `thread.idle` / `thread.failed` handlers that
  read `contextWindowUsage` from the thread timeline and call
  `threads.compact` at or above the threshold, a 15-minute per-thread
  cooldown, a global threshold with optional provider overrides, a
  `compact_now` RPC, and a `bb auto-compact` CLI (`status`, `check`, `now`). Threads whose
  provider cannot compact are reported as unsupported and skipped quietly.
- `app.tsx` — a **Compact** button in every thread header that compacts the
  visible thread on demand via the `compact_now` RPC.
- `skills/auto-compact/SKILL.md` — tells agents how the plugin behaves and
  how to use the CLI. BB imports it into agent threads automatically.
- `server.test.ts` — unit tests over the official fake-plugin harness
  (`@get-bb/plugin-sdk/testing`): threshold, cooldown, disabled state,
  failed threads, and the CLI.

```sh
bb auto-compact status [--json]
bb auto-compact check [thread-id] [--json]
bb auto-compact now [thread-id] [--json]
bb plugin config auto-compact set thresholdPercent 5
bb plugin config auto-compact set codexThresholdPercent 70
bb plugin config auto-compact set codexThresholdPercent "Use global"
```

In **Settings → Auto Compact**, the global context threshold ranges from 5% to
95% in 5% steps and defaults to 80%. Optional Claude Code, Codex, and Pi
thresholds default to **Use global**, following global changes until explicitly
overridden. Other providers use the global threshold. Both automatic checks
and the header's red usage indicator use the effective threshold. Existing
configuration remains valid, and the 15-minute cooldown still applies.

The settings use BB's native dropdowns and autosave. The SDK does not offer a
slider descriptor; a slider would require a custom settings section.

Run `npm test` for the suite, `npm run check` for the typecheck, and
`bb plugin build` before reinstalling.
