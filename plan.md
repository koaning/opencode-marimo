# Plan: run marimo where OpenCode runs (SSH support)

## Why
Everything the plugin does with marimo happens in Desktop's Electron main process (`src/main.ts`): listing notebooks, creating files, choosing ports, spawning `marimo edit`. For an SSH session the session folder (`/home/exedev` on `exe-host`) is a path on another machine. The Mac can't read it, so the picker is empty and "New notebook…" fails. The agent half (`src/index.ts`) only knows about notebooks through `~/.local/state/opencode-marimo/sessions.json` on the Mac.

## Shape
The plugin's server half owns marimo, on whichever machine runs the OpenCode server. Desktop's GUI half is a thin client.

```
Desktop window (thin)                       OpenCode server (local sidecar or remote over SSH)
  pill / header button / settings  ──RPC──▶  src/index.ts → src/server.ts manager
  session.server.client.rpc(Marimo)  ◀─event─  bindings, ports, `marimo edit` processes, settings
  side pane: http://localhost:<port> ──pane proxy (tunnel.open)──▶ marimo on that machine
```

Facts this relies on, all checked:
- **GUI loading:** Desktop loads plugin GUIs only from its own server's config (`plugin.list()`/`plugin.gui()` on the sidecar client).
- **Calling remote servers:** each `ServerRef.client` has `rpc(definition)` with methods and `events.subscribe`/`on`.
- **Instances:** a probe plugin on an isolated `opencode serve` showed that `setup` runs once per **location** (project directory), lazily, all in one process. Module state is per instance; `globalThis` is shared. RPC calls are routed by `location.directory`, or go to the server's own directory without one. A subscription without a location receives every instance's events.
- **Side pane:** the pane sends loopback URLs through the session's server (Electron proxy with `proxyBypassRules: "<-loopback>"`, `rpc["tunnel.open"]`). So `localhost:<port>` in a remote session reaches the remote machine.
- **Server dependencies:** OpenCode supplies `effect` and `@opencode/plugin` to server plugins at runtime, so a remote install needs only the source files.

## Changes
1. **`src/contract.ts`**: replace the Desktop `Ipc` with a portable RPC definition `opencode-marimo` (Effect schemas wrapped with `Schema.toStandardSchemaV1`). Use a plain object, no runtime `@opencode/plugin/rpc` import, so the GUI bundle needs nothing new.
   - Methods: `state`, `notebooks({directory})`, `bind({id, directory, name, create})`, `start({id})`, `stop({id})`, `unbind({id})`, `configure(settings)`.
   - Event: `changed(state)`.
   - Bindings are keyed by session id, since a server owns its own sessions.
2. **`src/server.ts`** (new; this is `src/main.ts`'s logic moved): one manager per server process, kept on `globalThis` so every location instance shares ports, processes and the one-session-per-notebook rule.
   - Persists `{ bindings, settings }` to `~/.local/state/opencode-marimo/state.json` (mode 0600, holds tokens).
   - Default command is `marimo` when it's on PATH, else `uvx marimo` (`exe-host` has uv but no marimo); `options.command` still wins.
   - Reference-counted: the last instance's cleanup stops every notebook, and process `exit` kills them too.
3. **`src/index.ts`**: on each setup, register the RPC handlers (delegating to the manager), the context hook (read the manager directly; skip if the text is already in `system`) and the `MARIMO_TOKEN` shell hook. `sessions.json` and `src/published.ts` go away.
4. **`src/window.tsx`**: replace `ctx.main(Marimo)` with a per-server client: `server.client.rpc(Marimo)`, calls made with the session's directory as location.
   - State lives per server in a Solid store, loaded with `state()` and kept current with `events.on("changed")`. It resubscribes when a server's client changes (restart).
   - If a server doesn't answer the RPC (plugin not installed there), the pill says so instead of failing.
   - `show()` only falls back to the system browser for local sessions.
   - The settings page edits the local server's settings.
5. **`src/gui.tsx`**: drop the `main` entry; delete `src/main.ts`.
6. **README**: install on each machine that runs OpenCode, plus the SSH notes.

## Known trade-offs
- Existing local bindings were stored in Desktop's main-process storage. Sessions will ask for their notebook once more; the notebook files are untouched.
- Two OpenCode servers on one machine that both load the plugin share `state.json`, and the last write wins. Only the server Desktop talks to acts on it.

## Rollout to exe-host (`opencode-desktop-link.exe.xyz`)
1. `rsync` the repo, without `node_modules`/`dist`/`.git`/`.context`, to `~/opencode-marimo`.
2. Create `~/.config/opencode/opencode.json` with `{"plugins":[{"package":"/home/exedev/opencode-marimo"}]}`.
3. Copy the `marimo-pair` skill to `~/.agents/skills/marimo-pair`, so the remote agent can pair.
4. Reload Desktop's remote service (`~/.opencode/desktop-ssh/2.2.5/opencode serve --service`, `127.0.0.1:49374`). Restart it if a reload doesn't pick up the plugin.

## Verification
- `bun run typecheck && bun run build`.
- **Local:** an isolated `opencode serve` with this plugin; drive the RPC from a bun script: `notebooks` → `bind` (create) → `start` → the URL answers with the token → `stop` → `unbind`. Check `changed` events arrive.
- **Remote:** the same script against exe-host's service over `ssh -L 49374`: notebook created in `/home/exedev`, marimo served on the remote machine, Studio mode starts through `uvx --with marimo-studio`.
- **Desktop (needs you):** restart Desktop, open the marimo pill in an `exe-host` session. Pick `demo.py`; the side pane shows the remote notebook and the agent pairs with it.
