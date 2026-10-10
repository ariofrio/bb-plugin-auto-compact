# bb-plugin-auto-compact

Automatically compacts a thread's context window when usage reaches a
configurable percentage (default 80%).

- `server.ts` — the backend: `thread.idle` / `thread.failed` handlers that
  read `contextWindowUsage` from the thread timeline and call
  `threads.compact` at or above the threshold, a 15-minute per-thread
  cooldown, global defaults with optional provider overrides, a
  `compact_now` RPC, and a `bb auto-compact` CLI (`status`, `check`, `now`).
  Threads whose provider cannot compact are reported as unsupported and skipped quietly.
- `app.tsx` — a **Compact** button in every thread header that compacts the
  visible thread on demand via the `compact_now` RPC.
- `settings.tsx` — a compact settings table with one row for global defaults
  and one per provider, using BB's vendored responsive select controls.
- `skills/auto-compact/SKILL.md` — tells agents how the plugin behaves and
  how to use the CLI. BB imports it into agent threads automatically.
- `server.test.ts` — unit tests over the official fake-plugin harness
  (`@get-bb/plugin-sdk/testing`): threshold, cooldown, disabled state,
  failed threads, and the CLI.

```sh
bb auto-compact status [--json]
bb auto-compact check [thread-id] [--json]
bb auto-compact now [thread-id] [--json]
bb plugin config auto-compact set enabled false
bb plugin config auto-compact set claudeCodeEnabled On
bb plugin config auto-compact set claudeCodeThresholdPercent 20
bb plugin config auto-compact set codexEnabled Off
bb plugin config auto-compact set codexThresholdPercent "Use global"
```

In **Settings → Auto Compact**, one table pairs **Mode** and **Threshold** in
each row: global defaults, Claude Code, Codex, and Pi.

- **Default** follows the corresponding global default and shows its current
  value (for example, **Default: Off** or **Default: 80%**).
- **On** enables the plugin's automatic compaction for that provider, even
  when the global default is off.
- **Off** leaves automatic compaction to the provider's harness. Manual
  compaction remains available.

Thresholds range from 5% to 95% in 5% steps, with an 80% global default. Mode
and threshold overrides inherit independently; changing a threshold does not
enable compaction. Other providers inherit both global defaults. Existing
configuration remains valid, and the 15-minute cooldown still applies.

For example, set global auto-compaction Off, Claude Code On at 20%, and Codex
Off. On Claude's 1M window this targets roughly 200K tokens while leaving Codex
to native compaction. A threshold triggers compaction after a turn settles; it
does not cap the context window. The header's usage indicator turns red at the
effective threshold only when auto-compaction is on for that thread.

Changes save automatically, and failures appear beside the table. The custom
settings section uses BB's responsive dropdowns, with a bottom sheet on phones.
The SDK has no slider descriptor; this custom section could support one, but
dropdowns keep explicit percentages and inheritance together in the same control.
The native form remains a fallback if the custom section cannot load.

Run `npm test` for the suite, `npm run check` for the typecheck, and
`bb plugin build` before reinstalling.
