# Portable repository publication

Date: 2026-10-17

Goal: publish the current agent-mods setup as a private cloneable repository and a public GitHub template.

Assumptions: Node.js 22 or newer; each computer authenticates agents locally; runtime data remains per computer.

Plan:
1. Export the current working files, including dashboard changes, without old Git history.
2. Exclude credentials, runtime stores, logs, backups and agent homes from both repositories.
3. Remove reference-only vendor material from the public export and generalize public fixtures.
4. Document clone, install, trust, diagnostics, dashboard access and updates.
5. Run isolated tests, syntax checks and secret scans before publication.
6. Verify repository visibility, template status and remote commit identities after pushing.

Verification: full node:test suite in each export; installer dry-run and configuration round-trip tests;
all distributable JavaScript syntax; secret scans of files and complete new Git histories;
independent fresh-clone tests; original working-file hashes preserved.

Scope: distribution and setup documentation. No live agent configuration, credential, runtime-data or original-checkout mutation.
