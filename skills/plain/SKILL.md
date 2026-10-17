---
name: plain
description: Set how plainly coding agents write final answers (beginner, expert or off), the terms the user already knows, a self-check of the last answer, and finish alerts. Use when the user types /plain, asks for plainer or more technical answers, says they already know a term, wants answer checks or finish alerts on or off, or asks whether the last answer was plain.
argument-hint: "[beginner | expert | off | know TERM, TERM | forget | review | notify on|off]"
---

# Plain talk

plain-talk keeps final answers plain (`beginner`) or clear (`expert`), each one complete on its own for a user who switches between several agent sessions. One level and one list of known terms are shared by every agent on this machine (Claude Code, Codex, Grok, Devin). The level starts at `off`. Agents with the agent-mods hooks get the rules at session start; this skill changes them, applies a change right away, and checks an answer.

Tool name: Claude Code shows it as `mcp__agent-mods__plain`; Grok calls it through `use_tool` as `agent-mods__plain`; other agents list it under the `agent-mods` MCP server. If the tool is unavailable, run the same command from a shell: `agent-mods plain ...` (or `node <checkout>/bin/agent-mods.mjs plain ...`).

## Steps

1. Read the argument exactly as `/plain` does:
   - nothing: `{"action": "status"}`. CLI: `agent-mods plain`
   - only `beginner`, `expert` or `off`: `{"action": "level", "level": "<that word>"}`. CLI: `agent-mods plain expert`
   - `know` alone: `{"action": "know"}` lists the known terms. CLI: `agent-mods plain know`
   - `know api, pull request`: `{"action": "know", "terms": "api, pull request"}`. CLI: `agent-mods plain know api, pull request`
   - `forget`: `{"action": "forget"}` clears the known terms. CLI: `agent-mods plain forget`
   - `review`, or the user asks whether your last answer was plain: go to step 4.
   - finish alerts (`notify on`, `notify off`, `notify test`, `notify after 45`, or the user asks for a sound or toast when a long turn ends): run `agent-mods notify <that>` from a shell; there is no tool action for it. `agent-mods notify` shows the current setting.
   - anything else: `{"action": "status"}`, which also prints the usage.
2. Show the user the reply text exactly as returned.
3. After a level change, call `{"action": "rules"}` (CLI: `agent-mods plain rules`) and follow the returned rules for the rest of this session, starting with your next message. Session-start rules only change in the next session. If the reply says plain-talk is off, stop following plain-talk rules given earlier.
4. Self-check (no other model is involved):
   1. Call `{"action": "review", "request": "<the user's last request>", "answer": "<your last final message>"}`. CLI: `agent-mods plain review --request "<request>" --answer "<answer>"`.
   2. Grade that message yourself against the returned rubric, producing exactly the JSON it asks for.
   3. Call `{"action": "review", "grade": "<that JSON>"}` (CLI: `agent-mods plain review --grade '<that JSON>'`) and show the user the grade line it returns.
   4. At the `beginner` level it may list terms under "I know this": offer each one as `say "/plain know <term>"`. Add a term only when the user says so.
   5. If the grade failed, rewrite the answer once as the reply instructs, fixing only the listed problems.

Terms are short (at most three words, lowercase): `next.js: a tool for web apps` is saved as `next.js`, and longer phrases are dropped. If the user asks for technical terms, more detail or exact wording, give them that, whatever the level.
