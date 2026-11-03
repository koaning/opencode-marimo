# opencode-marimo

Some small utilities to give every OpenCode session its own live [marimo](https://marimo.io) notebook. Think of it as [Claude Science](https://www.anthropic.com/news/claude-science-ai-workbench), but more open. 

![OpenCode chat on the left, the session's marimo notebook on the right](docs/images/session.png)

The agent pairs with the running kernel through the [marimo-pair](https://github.com/marimo-team/marimo-pair) skill,
so it runs cells and installs packages (sandboxed with uv) while you use the same notebook.

## Usage

- <kbd>Cmd</kbd>+<kbd>K</kbd> → **New marimo session**
- or click **marimo** in the session header, or type `/marimo` in any session

## Install

Requires OpenCode Desktop 2.2.5+, [marimo](https://docs.marimo.io/getting_started/installation/) and
[uv](https://docs.astral.sh/uv/).

```sh
npx skills add marimo-team/marimo-pair
bun install && bun run build
```

Add the plugin to `~/.config/opencode/opencode.json` and restart OpenCode Desktop:

```jsonc
{
  "plugins": [{ "package": "/path/to/opencode-marimo", "options": { "command": "marimo" } }],
}
```

`command` is optional: an absolute path to marimo if it isn't on a standard path.

## Develop

```sh
bun run dev        # rebuilds and reloads the GUI on save
bun run typecheck
```
