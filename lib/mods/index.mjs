// Mods in the order their hooks run. sessions goes first: it writes the session record the others read.
import sessions from './sessions.mjs'
import assumptions from './assumptions.mjs'
import design from './design.mjs'
import plain from './plain.mjs'
import ideas from './ideas.mjs'
import enhance from './enhance.mjs'
import clawd from './clawd.mjs'

export const MODS = [sessions, assumptions, design, plain, ideas, enhance, clawd]
