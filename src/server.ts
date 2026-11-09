import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { Binding, Settings as SettingsSchema, State } from "./contract"

type Settings = typeof SettingsSchema.Type
type Status = (typeof Binding.Type)["status"]

// What a session owns, persisted so it keeps the same notebook, port and URL across restarts.
interface Stored {
  readonly id: string
  readonly directory: string
  readonly notebook: string
  readonly port: number
  readonly token: string
}

interface Running {
  proc: ChildProcess
  ready: Promise<string>
  up: boolean
  /** The marimo-studio requirement it was started with, or null. */
  studio: string | null
  /** When an editor was last seen connected (or it started). */
  seen: number
}

/** What the agent half reads about a session's notebook. */
export interface View {
  readonly notebook: string
  readonly port: number
  readonly token: string
  readonly status: Status
  readonly studio: string | null
}

// The state file is private to the user (0600) because it holds the notebooks' access tokens.
const STATE_FILE = join(homedir(), ".local", "state", "opencode-marimo", "state.json")
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

// Servers started from a GUI or a service don't always inherit the shell's PATH, so add the usual install locations.
const searchPath = () =>
  [process.env.PATH, join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter)

const onPath = (name: string) =>
  searchPath()
    .split(delimiter)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return true
      } catch {
        return false
      }
    })

const IDLE_MINUTES = 30
const REAP_EVERY = 60_000

// `studio: true` or a requirement such as "marimo-studio==0.4.2", and `idle` minutes, in opencode.json, until the user
// changes them in Settings.
const settingsFrom = (options: Record<string, unknown>): Settings => ({
  studio: options.studio === true || (typeof options.studio === "string" && options.studio !== ""),
  requirement: typeof options.studio === "string" ? options.studio : "",
  idle: typeof options.idle === "number" && options.idle >= 0 ? options.idle : IDLE_MINUTES,
})

// Empty means the latest; a bare version such as "0.4.2" pins it.
const studioRequirement = (requirement: string) => {
  const spec = requirement.trim()
  return !spec ? "marimo-studio" : /^\d/.test(spec) ? `marimo-studio==${spec}` : spec
}

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

// How many editors have the notebook open, or undefined when marimo doesn't say.
const editors = (b: Stored) =>
  fetch(`http://127.0.0.1:${b.port}/api/status/connections`, {
    headers: { authorization: `Bearer ${b.token}` },
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .then(
      (body) => (typeof body?.active === "number" ? (body.active as number) : undefined),
      () => undefined,
    )

const kill = (it: Running) => {
  try {
    if (it.proc.pid) process.kill(-it.proc.pid, "SIGTERM")
  } catch {
    it.proc.kill()
  }
}

function load(options: Record<string, unknown>) {
  const defaults = settingsFrom(options)
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return {
      bindings: (saved.bindings ?? {}) as Record<string, Stored>,
      // Saved settings win, but settings added since they were saved keep their defaults.
      settings: { ...defaults, ...saved.settings } as Settings,
    }
  } catch {
    return { bindings: {} as Record<string, Stored>, settings: defaults }
  }
}

function createManager(options: Record<string, unknown>) {
  // marimo itself when it is installed, else uv runs it (a fresh machine often has uv but not marimo).
  const command =
    typeof options.command === "string" ? [options.command] : onPath("marimo") ? ["marimo"] : ["uvx", "marimo"]
  let { bindings, settings } = load(options)
  const running = new Map<string, Running>()
  const listeners = new Set<(state: typeof State.Type) => void>()
  let users = 0

  const statusOf = (id: string): Status =>
    running.get(id)?.up ? "running" : running.has(id) ? "starting" : "stopped"
  // A running notebook keeps the mode it started with; a stopped one starts with the current setting.
  const studioOf = (id: string) => {
    const it = running.get(id)
    if (it) return it.studio
    return settings.studio ? studioRequirement(settings.requirement) : null
  }

  const state = (): typeof State.Type => ({
    bindings: Object.values(bindings).map((b) => ({
      id: b.id,
      name: relative(b.directory, b.notebook),
      url: urlOf(b),
      status: statusOf(b.id),
    })),
    settings,
  })

  const persist = () => {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 })
      writeFileSync(STATE_FILE, JSON.stringify({ bindings, settings }, null, 2), { mode: 0o600 })
    } catch (error) {
      console.error("[opencode-marimo] could not save state", error)
    }
  }
  // Any instance's events reach every window, so only the oldest one sends them; the next takes over if it goes.
  const changed = () => {
    const [emitter] = listeners
    emitter?.(state())
  }

  const save = (id: string, binding: Stored | undefined) => {
    const next = { ...bindings }
    if (binding) next[id] = binding
    else delete next[id]
    bindings = next
    persist()
  }

  const allocatePort = async (except?: string) => {
    const taken = new Set(Object.values(bindings).flatMap((b) => (b.id === except ? [] : [b.port])))
    for (let port = PORTS.first; port <= PORTS.last; port++) {
      if (!taken.has(port) && (await portFree(port))) return port
    }
    throw new Error(`no free port in ${PORTS.first}-${PORTS.last}`)
  }

  const stopAll = () => {
    for (const it of running.values()) kill(it)
    running.clear()
  }
  // A server that exits without cleaning up must not leave its notebooks behind.
  process.once("exit", stopAll)

  const stop = (id: string) => {
    const it = running.get(id)
    if (it) kill(it)
  }
  // Every project's instance hears the same session events, so releasing twice must be harmless.
  const unbind = (id: string) => {
    if (!bindings[id]) return
    stop(id)
    save(id, undefined)
    changed()
  }
  let pruned = false

  // marimo's own --timeout only counts HTTP requests, so it would stop a notebook that is open but quiet. Ask each one
  // how many editors are connected instead, and stop it after `idle` minutes without any. Polls even when idle is 0, so
  // turning it on doesn't stop notebooks that were in use all along.
  const reap = async () => {
    for (const [id, it] of [...running]) {
      const binding = bindings[id]
      if (!it.up || !binding) continue
      if ((await editors(binding)) !== 0) it.seen = Date.now()
      else if (settings.idle > 0 && Date.now() - it.seen >= settings.idle * 60_000) {
        console.info("[opencode-marimo] stopping idle notebook", { id, notebook: binding.notebook })
        kill(it)
      }
    }
  }
  const reaper = setInterval(() => void reap(), REAP_EVERY)
  reaper.unref()

  return {
    state,
    notebooks: findNotebooks,

    /** The session's notebook, for the agent's context and marimo-pair's token. */
    view: (id: string): View | undefined => {
      const b = bindings[id]
      return b && { notebook: b.notebook, port: b.port, token: b.token, status: statusOf(id), studio: studioOf(id) }
    },
    /** The token of the notebook a shell command talks to, by its port. */
    tokenFor: (command: string) =>
      Object.values(bindings).find(
        (b) => command.includes(`localhost:${b.port}`) || command.includes(`127.0.0.1:${b.port}`),
      )?.token,

    bind: async (input: { id: string; directory: string; name: string; create: boolean }) => {
      const { id, directory, name, create } = input
      const notebook = resolve(directory, name.endsWith(".py") ? name : `${name}.py`)
      if (!inside(directory, notebook)) throw new Error("the notebook must be inside the session's folder")

      const owner = Object.values(bindings).find((b) => b.id !== id && b.notebook === notebook)
      const rel = relative(directory, notebook)
      if (owner) return { owner: owner.id, name: rel }

      if (!existsSync(notebook)) {
        if (!create) throw new Error(`${name} does not exist`)
        await writeFile(notebook, TEMPLATE, { flag: "wx" })
      }

      const previous = bindings[id]
      if (previous?.notebook !== notebook) {
        const it = running.get(id)
        if (it) kill(it)
      }
      save(id, {
        id,
        directory,
        notebook,
        port: previous?.port ?? (await allocatePort(id)),
        token: previous?.token ?? randomBytes(18).toString("base64url"),
      })
      changed()
      return { owner: null, name: rel }
    },

    start: async (id: string) => {
      const existing = running.get(id)
      if (existing) return existing.ready

      let binding = bindings[id]
      if (!binding) throw new Error("this session has no notebook yet")
      // The session keeps its port; only move it if another program took it meanwhile.
      if (!(await portFree(binding.port))) {
        const port = await allocatePort(id)
        console.warn("[opencode-marimo] marimo port taken, moving session", { id, from: binding.port, to: port })
        binding = { ...binding, port }
        save(id, binding)
      }

      const edit = [
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
      ]
      // marimo-studio is a marimo extension: uvx runs marimo with it installed alongside.
      const studio = settings.studio ? studioRequirement(settings.requirement) : null
      const [file, ...args] = studio ? ["uvx", "--with", studio, "marimo", ...edit] : [...command, ...edit]
      const proc = spawn(file!, args, {
        cwd: binding.directory,
        detached: true,
        env: { ...process.env, PATH: searchPath() },
      })
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
      const it: Running = { proc, ready, up: false, studio, seen: Date.now() }
      running.set(id, it)
      changed()

      proc.on("exit", () => {
        if (running.get(id) !== it) return
        running.delete(id)
        changed()
      })
      it.ready.then(
        () => {
          it.up = true
          it.seen = Date.now()
          changed()
        },
        (error) => {
          console.error("[opencode-marimo] marimo failed to start", { id, error: String(error) })
          if (running.get(id) === it) running.delete(id)
          kill(it)
          changed()
        },
      )
      return it.ready
    },

    stop,

    unbind,

    /** A deleted session lets go of its notebook and port. */
    forget: unbind,
    /** An archived session can come back, so it keeps its notebook; only its marimo stops. */
    archive: stop,

    /** Once per manager: forget bindings of sessions deleted while this server was down. `undefined` means unknown. */
    prune: async (exists: (id: string) => Promise<boolean | undefined>) => {
      if (pruned) return
      pruned = true
      for (const id of Object.keys(bindings)) if ((await exists(id)) === false) unbind(id)
    },

    configure: (next: Settings) => {
      settings = next
      persist()
      changed()
    },

    subscribe: (listener: (state: typeof State.Type) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    retain: () => void users++,
    /** The last plugin instance going away (a reload or shutdown) stops every notebook. */
    release: () => {
      if (--users > 0) return false
      clearInterval(reaper)
      stopAll()
      process.off("exit", stopAll)
      return true
    },
  }
}

export type Manager = ReturnType<typeof createManager>

// OpenCode sets the plugin up once per project directory, in one process: they all share this manager, so ports,
// processes and "one session per notebook" hold across every project on this server.
const KEY = Symbol.for("opencode-marimo.manager")
const shared = globalThis as { [KEY]?: Manager }

export function acquire(options: Record<string, unknown>) {
  const manager = (shared[KEY] ??= createManager(options))
  manager.retain()
  return {
    manager,
    release: () => {
      if (manager.release() && shared[KEY] === manager) delete shared[KEY]
    },
  }
}
