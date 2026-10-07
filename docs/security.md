# Security model

## What this plugin can do — read this first

dsh plugins run with the user's full privileges. This plugin installs, builds and links other plugins, so it can cause
**third-party code to run on your computer**:

| Step | Code that may run | Default |
|---|---|---|
| `npm install` of a plugin's dependencies | the dependencies' `preinstall`/`install`/`postinstall`/`prepare` scripts | **blocked** (`--ignore-scripts`); asks first if any exist |
| `npm run build` for a git plugin | the plugin's own build script | **blocked**; asks first |
| Loading the deployed plugin | the plugin itself, when dsh restarts | by design: Apply is your decision |

You can answer **Allow this time** or **Always allow for this plugin**. "Always allow" is bound to the npm publisher account
(or the git origin URL) you approved; a different publisher asks again. **Reapply all** never prompts: it only runs plugins you always allowed.

## Trust boundaries

* **The HTTP API** is reachable only through dsh's own authentication (token cookie + Host/Origin checks). If that check is unavailable
  the API serves nothing. Requests must be `application/json` (closes simple cross-site form posts) and are limited to 1 MB.
* **The registry file** (`$DSH_HOME/local-plugins/registry.json`) is treated as untrusted input. On every load each entry is validated; core
  package paths must be exactly `<node_modules>/<name>` where dsh resolves the package, backups must live under `.backup`, worktrees under `.work`,
  and plugin names must be valid npm names. Entries that fail are **quarantined** (kept, never acted on).
* **Package archives** are checked before extraction (no absolute or `..` entries) and after (no symlinks pointing outside, no devices/fifos).
* **Inputs** — package names, versions/ranges, git locations and refs — are validated; nothing starting with `-` can reach `git` or `npm` as an
  option, `--` separates positional arguments, no shell is ever used (arguments are passed as arrays), and git's `ext::` transport is not accepted.

## Filesystem

* Managed folders (`local-plugins/`, `.backup/`, `.txn/`, `logs/`) are tightened to `0700`; the registry, journal entries and logs are `0600`.
* The stable link is only ever swapped to a directory that resolves **inside** `.deployed/` (symlinks that lead outside are refused), the swap is atomic, and a real
  directory or file sitting where the link should be is never replaced.
* Deletes never follow symlinks (`rmSync`); `node_modules` links into the dsh install are removed as links only.
* **Core packages**: the original package folder is moved (not deleted) to `.backup/` before a symlink replaces it. This needs write access to the global dsh install.

## Secrets

Every line a child process prints, every operation error, every URL shown in the UI and the structured operation log go through one redaction pass
(URL credentials, GitHub/npm/`sk-` tokens, auth headers, `.npmrc` auth, `token=`/`password=` pairs). Registry entries keep the original git URL (it is needed to fetch) in a `0600` file; the UI only ever receives the redacted form.

## Residual risks (accepted)

* Anyone who can use your dsh login can drive this API, i.e. can run builds you approved before. Protect the dsh token like a shell.
* "Allow" means *trust the code*: scripts run with your privileges. The publisher binding limits silent takeover; it cannot judge intent.
* The load check proves files parse and entries exist; it does not execute the plugin.
* A plugin that crashes dsh before this manager loads cannot be reverted automatically — use `scripts/undo.mjs` from a terminal.
* Windows is not supported (symlinks, rsync).
