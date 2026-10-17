# Setup on another Windows PC

Install Node.js 22 or newer and Git. Confirm with `node -v` and `git --version`.
Install and open each agent you plan to use before running the installer. Only existing homes are discovered.
Sign in to each agent on this PC using its own login flow.

Clone into a permanent folder without spaces, for example `C:\Tools\agent-mods`.
Run PowerShell from the cloned folder:

```powershell
node .\bin\agent-mods.mjs install --dry-run
node .\bin\agent-mods.mjs install
```

Use `--only claude,codex` on both install commands to limit installation.
The default installer checks the normal Claude, Codex and Grok homes and Devin's app-data folder.
Grok and Devin import hooks through the default Claude configuration, so inspect the dry run when using those agents.
Optional legacy alternate Claude/Codex homes named `92`, `gmail` and `robopro` are also discovered if present.
Arbitrary custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` folders are not automatically discovered.

Restart the installed agents. For Codex, trust the new hooks:

```powershell
node .\bin\agent-mods.mjs trust-codex
```

Start one session and send one prompt in each installed agent, then check:

```powershell
node .\bin\agent-mods.mjs doctor --deep
```

Doctor checks hook activity for all four agents. A fresh installation or an agent you do not use can report no hook activity.
Review the individual results. Missing installation, hook trust and PATH checks still need attention for the agents you use.

The installer creates shims in `%USERPROFILE%\bin`.
If doctor reports that this folder is missing from PATH, add it to your user PATH and open a new terminal.
The `node .\bin\agent-mods.mjs` commands work directly from the checkout before the shim is on PATH.

Start the dashboard:

```powershell
node .\bin\agent-mods.mjs dashboard
node .\bin\agent-mods.mjs dashboard status
node .\bin\agent-mods.mjs dashboard stop
```

Open the printed `http://127.0.0.1:4747/?t=...` link, which contains a local access token.
The port can change if it is occupied. A fresh browser opening the bare URL has no authenticated session.
Each PC runs its own dashboard. A different PC cannot open this PC's localhost page.
Do not share the printed token link.

Data stays in `%USERPROFILE%\.agent-mods`, or the folder selected by `AGENT_MODS_HOME`.
Sessions, ideas, rules, dashboard tokens and installation records are local to this PC.
Different projects are detected from the current Git repository automatically.
Do not copy agent credential/config homes or a previous PC's agent-mods runtime store into the repository.

Keep the checkout in place after installation because hooks reference its absolute path.
After moving it, rerun install and trust-codex. To update, use `git pull --ff-only` from the checkout,
inspect `install --dry-run`, reinstall and restart agents. Run trust-codex again if the hook command changed.
Use `node .\bin\agent-mods.mjs uninstall --dry-run` to review removal before running uninstall.

The installer merges its entries into existing configuration and skips foreign skills.
Its internal JSON writes create adjacent backups; MCP registration is delegated to the agent CLIs.
Keep your own backup of existing configuration before installation if you need a complete restore point.
