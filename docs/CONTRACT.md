# Mod contract (read before writing or changing a mod)

A mod is one ES module at `lib/mods/<name>.mjs` whose default export is:

```js
export default {
  name: 'ideas',                       // also the config switch: config.mods.<name>
  hooks: { SessionStart(ctx) {}, UserPromptSubmit(ctx) {}, PostToolUse(ctx) {}, Stop(ctx) {}, SessionEnd(ctx) {}, Notification(ctx) {} },
  tools: [{ name, description, inputSchema, run(args, mctx) }],   // MCP tools
  cli: [{ name, aliases?, summary, usage, run(cctx) }],            // CLI subcommands
}
```

Zero dependencies: `node:` built-ins and files in this repo only. Node 22+ ESM. 2-space indent, no
semicolons, single quotes (match `lib/core/*.mjs`). Comments explain why, not what.

## Hooks: `ctx`

Handlers may be sync or async. They run in this order: sessions, assumptions, design, plain, ideas,
enhance, clawd. A handler that throws is logged and skipped; it never breaks the agent.

- `ctx.ev` normalized event (see `lib/core/agents.mjs` `normalizeEvent`):
  `agent` ('claude'|'codex'|'grok'|'devin'), `home` (agent config home, canonical path or null),
  `event`, `sessionId`, `cwd` (canonical), `prompt`, `toolName`, `toolKind`
  ('edit'|'todo'|'ask'|'shell'|'read'|'search'|'web'|'agent'|'mcp'|'other'|null), `toolInput`,
  `toolResponse`, `toolFailed`, `edits` ([{ path: canonical absolute, op }]), `todos`
  ([{ id, text, status: 'pending'|'in_progress'|'completed' }] or null), `lastAssistantMessage`,
  `stopHookActive`, `isSubagent`, `source`, `reason`, `notificationType`, `message`, `sessionTitle`,
  `transcriptPath`, `turnId`, `attended` (Claude only: true/false/null), `entrypoint`, `pid`, `raw`.
- `ctx.now` ms timestamp for this event. Use it, not `Date.now()`, so tests are deterministic.
- `ctx.project` `{ cwd, worktreeKey, repoKey, isRepo, name, projectId, worktreeId }`.
  Per-repo data (shared by every worktree): `projectFile(ctx.project, 'ideas.json')` from `lib/core/store.mjs`.
- `ctx.store` bound to the store root: `readJson(rel, fallback)`, `writeJson(rel, data)` (atomic),
  `update(rel, fallback, fn)` (locked read-modify-write; return the next value, or undefined for no
  write), `append(rel, value)` (JSONL), `lines(rel)`, `list(rel)`, `remove(rel)`, `exists(rel)`, `path(...)`.
  Any value two processes can change must go through `update`, never read-then-write.
- `ctx.session` `{ key, agent, id, state(mod) }`; `state(mod)` returns `{ read(fallback), write(data), update(fn, fallback) }`
  for this session's private file `sessions/<key>/<mod>.json`.
- `ctx.record` this session's public record, set by the sessions mod before the others run (may be null).
- `ctx.out.context` array of strings shown to the MODEL (additionalContext). The runtime queues it for
  agents that cannot take context on this event (Grok at SessionStart/UserPromptSubmit, Devin at
  PreToolUse) and delivers it with that session's next eligible event.
- `ctx.out.notice` array of strings shown to the USER (systemMessage). Dropped where unsupported (Grok).
- `ctx.out.block` Stop only: a string makes the agent continue with it as the reason. Respect
  `ctx.ev.stopHookActive` (never block twice in a row). Use sparingly: it costs a model turn.
- `ctx.config` merged config (`lib/core/store.mjs` `DEFAULT_CONFIG` + `config.json`). `ctx.log(msg)`.

Hook rules (hot path: every prompt and every edit, in four agents):
- No model calls, no network, no child processes on the hook path (node start is already ~100 ms).
  A detached `spawn(..., { detached: true, stdio: 'ignore', windowsHide: true }).unref()` is allowed
  where noted (notifications). Its target must be `node` (or a GUI-subsystem exe): powershell.exe
  started detached has no console and exits 0 without running anything. Start PowerShell attached
  and hidden from inside the detached node process (see `lib/mods/plain-notify.mjs`).
- Context parts share `MAX_CONTEXT_CHARS`; when they overflow, the longest parts are cut first
  (`fitContext`), so keep each part short and put the important line first.
- Only small JSON files; never scan transcripts. Target < 30 ms of the mod's own work.
- Never write to stdout or stderr. Never `process.exit`.
- Registered events: SessionStart, UserPromptSubmit, PostToolUse (edit and todo tools only), Stop,
  SessionEnd, Notification (Claude and Grok only). PreToolUse is not registered.
- `ctx.ev.isSubagent` events come from a subagent; most mods ignore them for "turn" state.
- Grok: SessionStart and UserPromptSubmit cannot reach the model directly (handled by the runtime
  queue). Devin: there is no `cwd` in the payload (the runtime fills it). Codex: Stop only takes `block`.

Text shown to a model that came from ANOTHER session (titles, prompts, idea text, messages) must go
through `sanitize()` from `lib/core/text.mjs` and be framed as data from another session, not as
instructions.

## MCP tools: `run(args, mctx)`

Return `{ text, data?, isError? }`. `text` is the only thing any model reads, so everything the model
needs goes in it. `data` (plain object) travels in the result's `_meta` (`agent-mods/data`), for tests
and programs; it is never sent as `structuredContent`, because Codex shows that JSON to the model in
place of the text. Throwing returns an error result.

A mod may also export `briefing(mctx, { project, caller })` returning text, a list of texts or null:
the standing context its SessionStart hook injects for that project, with no side effects beyond
delivering the caller's own messages. The core `briefing` tool joins every enabled mod's part, so an
agent that never received session-start context (Grok, or a session older than the install) gets it
in one call. Tool names: lowercase snake_case, no `__`,
unique across mods. Every tool that is project-scoped takes an optional `cwd` string argument.

- `mctx.agent` caller agent ('claude'|'codex'|'grok'|'devin'|null), `mctx.clientName`, `mctx.env`.
- `mctx.store`, `mctx.config`, `mctx.now`, `mctx.log(msg)`.
- `mctx.project(cwd?)` project info for `cwd` or the server's default directory.
- `mctx.caller(args, project?)` the calling session `{ agent, id, key, record }` or null (uses
  `args.session_id`, the agent's session env var, else the newest live session of that agent in that
  worktree; see `lib/core/session-records.mjs`).

Keep input schemas small and descriptions short and specific: every connected agent pays for them in
context. Prefer one tool with an `action` enum over many near-identical tools.

## CLI: `run(cctx)` returns an exit code

`cctx.positionals`, `cctx.flags` (`--name value`, `--name=value`, booleans listed in
`lib/core/cli.mjs`), `cctx.json`, `cctx.print(text)`, `cctx.printJson(value)`, `cctx.error(text)`,
`cctx.store`, `cctx.config`, `cctx.now`, `cctx.cwd`, `cctx.project`. The user runs these from any
terminal (`agent-mods <name> ...`), and skills fall back to them when MCP is unavailable.

## Session records (owned by the sessions mod)

`sessions/<agent>__<id>.json`, read with `lib/core/session-records.mjs` (`readRecord`,
`listRecords`, `liveRecords`, `isAlive`, `resolveCallerSession`). Shape:

```
{ v, agent, home, id, key, pid, cwd, worktreeKey, repoKey, projectId, startedAt, beatAt, endedAt,
  state: 'working'|'waiting'|'idle'|'ended', waitingFor, turns, turnStartedAt, lastPrompt,
  lastAnswer, title, done, doing, next, tasks: [{ id, text, status }], files: [rel], edits: { rel: ms } }
```

Other mods read records; only the sessions mod writes them.

## Skills: `skills/<skill>/SKILL.md`

Frontmatter: `name` (= folder name), `description` (one line, what + when; under 1024 chars, no `<`
or `>`), optional `argument-hint`. Body: steps that work in every agent. Name tools generically
("the agent-mods `shelve_idea` tool"; Claude shows it as `mcp__agent-mods__shelve_idea`, Grok via
`use_tool` with `agent-mods__shelve_idea`). Always give the CLI fallback (`agent-mods ...`).
Skill names in use: idea, tracker, monitor, assumptions, plain, enhance, design-decisions, clawd.

## Tests: `test/<mod>.test.mjs` with `node:test`

Use `test/helpers.mjs`: `tempStore()` (isolated `AGENT_MODS_HOME`), `makeRepo()`, `makeWorktree()`,
`hook(agent, event, fields, { cwd, env, now, mods: [yourMod] })` (payloads shaped exactly like each
agent's), `contextOf(reply)`, `mcpClient({ mods, env, clientName })`. Cover every agent shape for
the hooks you register (at least claude, codex, grok, devin), the MCP tools, the CLI, and the
original mod's test contracts where they still apply. Run: `node --test test/<mod>.test.mjs`.
