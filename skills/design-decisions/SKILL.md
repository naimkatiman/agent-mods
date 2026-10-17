---
name: design-decisions
description: Use whenever you are about to ask the user to choose a visual design direction (style, layout, palette, typography, component look, hero treatment, density, mood), before building or restyling UI in a repo, or when the user types /design-decisions or /design-decisions clear. Shows SVG mockups in a browser picker and remembers each pick per repo across Claude Code, Codex, Grok and Devin.
argument-hint: "[clear]"
---

# Design decisions

Design questions get answered visually, once per repo, and every agent on that repo follows the answer.
The tools are the agent-mods MCP tools `design_decisions` and `design_pick` (Claude Code shows them as
`mcp__agent-mods__design_pick`; Grok calls them through `use_tool` as `agent-mods__design_pick`).
Without MCP, use the `agent-mods design` command given in each step.

## 1. Load what is already decided

Call the agent-mods `design_decisions` tool with `action: "list"` and `cwd` set to the repo root
(CLI: `agent-mods design list --cwd <repo>`). Treat every listed decision as settled: build with it
and do not ask again unless the user wants to revisit one.

- `/design-decisions`: print the returned `text` exactly.
- `/design-decisions clear`: this forgets the decisions for every agent on the repo, so confirm once
  with the user, then call `design_decisions` with `action: "clear"` (add `question` or `topic` to
  forget only one) and print the returned `text`
  (CLI: `agent-mods design clear [--question <q> | --topic <t>] --cwd <repo>`).

## 2. Ask a new design question with mockups

# Visual design direction
Whenever you ask the user to choose a design direction (visual style, layout, palette, typography, component look, hero treatment, density, mood…), call the agent-mods `design_pick` tool and give EVERY option an `svg` that is one self-contained SVG document drawing that direction:
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300">…</svg>
Draw the real thing: actual colors, type (font-family, sizes, weights), layout blocks, sample copy, buttons. Not a description of it. Make the options visibly different from each other. No scripts, no external images or font links, under ~8 KB each. The user sees all options rendered side by side and picks one visually.

Draw 2 to 4 options per question (the tool takes up to 6), 1 to 4 questions per call. Give each
question a short `header` (40 characters at most) and a `topic` (`palette`, `typography`, `layout`,
`style`, `density`, `mood` or `component:<name>`), and each option a short `label`, a one-line
`description` and its `svg`. Call `design_pick` with `questions` and `cwd`. It opens the picker in the
user's browser and waits up to 40 seconds, then returns a `status`:

- `answered`: use `answers` (keyed by question text). The pick is already remembered for the repo.
- `pending`: tell the user in one line that the picker is open at `url`, then call `design_pick` again
  with only `pick_id` (and `cwd`). Repeat until it returns `answered` or `closed`. After about 10
  rounds, stop and ask in chat instead.
- `closed`: the user closed the picker without choosing. Ask what they want instead.
- `already_decided`: follow the returned decisions. Pass `force: true` only when the user asks to
  revisit them.
- `expired`: the picker is gone and nobody answered. Ask in chat, or call `design_pick` with the
  questions again.

CLI: write the questions (the same JSON array) to a file and run
`agent-mods design pick <file> --cwd <repo>`. It prints the picker URL, blocks until the user answers
(`--timeout` seconds, default 600) and prints the result as JSON with the same `status` values.

## 3. Answers given in chat

If the user answers a design question in chat instead, call `design_decisions` with
`action: "record"`, the `question`, their `choice` in their words, and the `description` and `topic`
of the option when one fits (CLI: `agent-mods design record --question <q> --choice <c>
[--description <d>] [--topic <t>] --cwd <repo>`).

## 4. Build

Build with the chosen direction. An answer of the form
`Mix of "A" and "B": blend both directions into one design` means combine both options into one
design.
