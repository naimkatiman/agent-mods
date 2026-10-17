#!/usr/bin/env node
// stdio MCP server for every agent: `node D:/Ai/agent-mods/bin/mcp-server.mjs`.
// Registered once in ~/.claude.json (Claude Code, and imported by Grok and Devin Local) and per
// CODEX_HOME for Codex (with AGENT_MODS_AGENT=codex).
import { createMcpServer } from '../lib/core/mcp.mjs'
import { MODS } from '../lib/mods/index.mjs'

createMcpServer({ mods: MODS })
