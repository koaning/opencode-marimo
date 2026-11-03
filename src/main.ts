import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/gui"
import { Marimo } from "./contract"
import { PUBLISHED_FILE, type Published } from "./published"

// What a session owns, persisted so it keeps the same notebook, port and URL across restarts.
const Stored = Schema.Struct({
  server: Schema.String,
  id: Schema.String,
  directory: Schema.String,
  notebook: Schema.String,
  port: Schema.Number,
  token: Schema.String,
})
type Stored = typeof Stored.Type

interface Running {
  proc: ChildProcess
  ready: Promise<string>
  up: boolean
}

const PORTS = { first: 27180, last: 27979 }
const READY = /URL:\s*http/
const ANSI = /\x1b\[[0-9;]*m/g
const SKIP = new Set(["node_modules", "__pycache__", "venv", "site-packages", "dist", "build"])

// Capped below 3.15: marimo depends on loro, which has no 3.15 wheels yet, so uv would try to build it.
const TEMPLATE = `# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["marimo"]
# ///

import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return (mo,)


if __name__ == "__main__":
    app.run()
`

// GUI apps on macOS don't inherit the shell's PATH, so add the usual install locations (marimo and uv).
const searchPath = () =>
  [process.env.PATH, join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter)

const keyOf = (s: { server: string; id: string }) => `${s.server}/${s.id}`
const urlOf = (b: Stored) => `http://localhost:${b.port}?access_token=${b.token}`

const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)))
  })

const inside = (directory: string, file: string) => {
  const rel = relative(directory, file)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

async function findNotebooks(directory: string, depth = 3): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, left: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".") || found.length >= 200) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (left > 0 && !SKIP.has(entry.name)) await walk(path, left - 1)
      } else if (entry.name.endsWith(".py")) {
        const text = await readFile(path, "utf8").catch(() => "")
        if (text.includes("marimo.App(")) found.push(relative(directory, path))
      }
    }
  }
  await walk(directory, depth)
  return found.sort()
}

export const main: Plugin.MainSetup = (ctx) => {
  const command = typeof ctx.options.command === "string" ? ctx.options.command : "marimo"
  const store = ctx.storage.store("bindings", {
    schema: Schema.Record(Schema.String, Stored),
    initial: {},
  })
  const running = new Map<string, Running>()
  ctx.log.write("info", "opencode-marimo main started", { bindings: Object.keys(store.value).length })

  const statusOf = (key: string): Published[string]["status"] =>
    running.get(key)?.up ? "running" : running.has(key) ? "starting" : "stopped"

  // Share bindings with the server part, which tells each session's agent about its notebook.
  const publish = () => {
    const out: Record<string, Published[string]> = {}
    for (const [key, b] of Object.entries(store.value)) {
      out[b.id] = { notebook: b.notebook, directory: b.directory, port: b.port, token: b.token, status: statusOf(key) }
    }
    try {
      mkdirSync(dirname(PUBLISHED_FILE), { recursive: true, mode: 0o700 })
      writeFileSync(PUBLISHED_FILE, JSON.stringify(out, null, 2), { mode: 0o600 })
    } catch (error) {
      ctx.log.write("error", "could not publish marimo sessions", { error: String(error) })
    }
  }
  const changed = () => {
    provider.changed()
    publish()
  }

  const save = (key: string, binding: Stored | undefined) => {
    const next = { ...store.value }
    if (binding) next[key] = binding
    else delete next[key]
    store.set(next)
  }

  const allocatePort = async (except?: string) => {
    const taken = new Set(Object.entries(store.value).flatMap(([k, b]) => (k === except ? [] : [b.port])))
    for (let port = PORTS.first; port <= PORTS.last; port++) {
      if (!taken.has(port) && (await portFree(port))) return port
    }
    throw new Error(`no free port in ${PORTS.first}-${PORTS.last}`)
  }

  const kill = (it: Running) => {
    try {
      if (it.proc.pid) process.kill(-it.proc.pid, "SIGTERM")
    } catch {
      it.proc.kill()
    }
  }

  const provider = ctx.provide(Marimo, {
    state: () => ({
      bindings: Object.entries(store.value).map(([key, b]) => ({
        server: b.server,
        id: b.id,
        name: relative(b.directory, b.notebook),
        url: urlOf(b),
        status: statusOf(key),
      })),
    }),

    notebooks: (directory) => findNotebooks(directory),

    bind: async ({ server, id, directory, name, create }) => {
      const key = keyOf({ server, id })
      const notebook = resolve(directory, name.endsWith(".py") ? name : `${name}.py`)
      if (!inside(directory, notebook)) throw new Error("the notebook must be inside the session's folder")

      const owner = Object.entries(store.value).find(([k, b]) => k !== key && b.notebook === notebook)?.[1]
      const rel = relative(directory, notebook)
      if (owner) return { owner: { server: owner.server, id: owner.id }, name: rel }

      if (!existsSync(notebook)) {
        if (!create) throw new Error(`${name} does not exist`)
        await writeFile(notebook, TEMPLATE, { flag: "wx" })
      }

      const previous = store.value[key]
      if (previous?.notebook !== notebook) {
        const it = running.get(key)
        if (it) kill(it)
      }
      save(key, {
        server,
        id,
        directory,
        notebook,
        port: previous?.port ?? (await allocatePort(key)),
        token: previous?.token ?? randomBytes(18).toString("base64url"),
      })
      changed()
      return { owner: null, name: rel }
    },

    start: async (session) => {
      const key = keyOf(session)
      const existing = running.get(key)
      if (existing) return existing.ready

      let binding = store.value[key]
      if (!binding) throw new Error("this session has no notebook yet")
      // The session keeps its port; only move it if another program took it meanwhile.
      if (!(await portFree(binding.port))) {
        const port = await allocatePort(key)
        ctx.log.write("warn", "marimo port taken, moving session", { key, from: binding.port, to: port })
        binding = { ...binding, port }
        save(key, binding)
      }

      const proc = spawn(
        command,
        [
          "edit",
          "--headless",
          "--skip-update-check",
          "--watch",
          "--sandbox",
          "--port",
          String(binding.port),
          "--token-password-file",
          "-",
          binding.notebook,
        ],
        { cwd: binding.directory, detached: true, env: { ...process.env, PATH: searchPath() } },
      )
      proc.stdin?.end(binding.token)

      const url = urlOf(binding)
      const ready = new Promise<string>((done, fail) => {
        let output = ""
        const onData = (chunk: Buffer) => {
          output += chunk.toString().replace(ANSI, "")
          if (READY.test(output)) done(url)
        }
        proc.stdout?.on("data", onData)
        proc.stderr?.on("data", onData)
        proc.on("error", fail)
        proc.on("exit", (code) => fail(new Error(`marimo exited (${code}): ${output.trim().slice(-500)}`)))
      })
      const it: Running = { proc, ready, up: false }
      running.set(key, it)
      changed()

      proc.on("exit", () => {
        if (running.get(key) !== it) return
        running.delete(key)
        changed()
      })
      it.ready.then(
        () => {
          it.up = true
          ctx.log.write("info", "marimo started", { key, notebook: binding.notebook, port: binding.port })
          changed()
        },
        (error) => {
          ctx.log.write("error", "marimo failed to start", { key, error: String(error) })
          if (running.get(key) === it) running.delete(key)
          kill(it)
          changed()
        },
      )
      return it.ready
    },

    stop: (session) => {
      const it = running.get(keyOf(session))
      if (it) kill(it)
    },

    unbind: (session) => {
      const key = keyOf(session)
      const it = running.get(key)
      if (it) kill(it)
      save(key, undefined)
      changed()
    },
  })

  publish()

  return () => {
    for (const it of running.values()) kill(it)
    running.clear()
    publish()
  }
}
