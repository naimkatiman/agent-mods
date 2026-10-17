---
name: clawd
description: Use only when the user types /clawd or asks Clawd, the pixel-art companion, to change hat, list hats, be petted, dance, party, toggle shades, hide or show. Not for anything else.
argument-hint: "[hat name|random | hats | pet | dance | party | shades | hide | show]"
---

# Clawd

Clawd is a pixel-art pet: one Clawd per live agent session (Claude Code, Codex, Grok, Devin), drawn in a terminal pane by `agent-mods clawd watch`. Each one paces while its agent works, says which file it is editing, parties when a turn ends, sweats when a tool fails, shows `waiting` when its agent needs the user, and naps after 5 idle minutes. The hat, shades and hide settings are shared by every agent on this machine.

Tool name: Claude Code shows it as `mcp__agent-mods__clawd`; Grok calls it through `use_tool` as `agent-mods__clawd`; other agents list it under the `agent-mods` MCP server.

## Steps

1. Turn the user's words into a verb and an argument: `hat` (argument: a hat name, `random`, or nothing for the next hat in the list), `hats`, `pet`, `dance`, `party`, `shades`, `hide`, `show`. With nothing given, the verb is `status`.
2. Call the agent-mods `clawd` tool with `{"verb": "<verb>", "arg": "<argument, only for hat>", "cwd": "<your working directory>"}`. If the tool is unavailable, run `agent-mods clawd <verb> [argument]` from your working directory instead.
3. Reply with the returned text exactly, adding nothing.
4. If the user asks to see Clawd, tell them to run `agent-mods clawd watch` in a separate terminal pane (`--all` shows every project, `--project <dir>` one project; ctrl+c closes it). Never start it yourself: it keeps running until they close it.
