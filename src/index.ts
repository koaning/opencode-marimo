import { Plugin } from "@opencode/plugin"
import { Marimo } from "./contract"
import { acquire, type View } from "./server"

const MARKER = "This session owns one marimo notebook:"
// What `session.get` rejects with for a session that doesn't exist: the in-process tag, and the HTTP client's.
const MISSING = new Set(["Session.NotFoundError", "SessionNotFoundError"])

const instructions = (b: View) => {
  const url = `http://localhost:${b.port}`
  return [
    `${MARKER} ${b.notebook}, served at ${url} (currently ${b.status}).`,
    `When the user talks about "the notebook" or asks you to work in marimo, pair with this server only.`,
    `Do not run discover-servers.sh or look for other marimo servers: other servers on this machine belong to other work.`,
    `Use the marimo-pair skill's execute-code.sh with --url ${url}/. MARIMO_TOKEN is added to the environment automatically`,
    `for shell commands that mention ${url}, so --token is optional.`,
    `The notebook runs with --watch (edits to the file reload) and --sandbox (dependencies live in its PEP 723 header).`,
    b.status === "running"
      ? `marimo-pair needs the notebook open in an editor; the user has it in OpenCode's side pane.`
      : `It is not running right now: ask the user to start it from the marimo pill above the message box.`,
    ...(b.studio
      ? [
          `The notebook runs with marimo-studio, which turns named notebook results into views (pages, slides, papers)`,
          `kept in folders beside the notebook. Before building or editing views, run`,
          `\`uvx --with "${b.studio}" agent-plugins read marimo-studio\` and follow those instructions.`,
        ]
      : []),
  ].join(" ")
}

export default Plugin.define({
  id: "opencode-marimo",
  async setup(ctx) {
    // One setup per project directory; the manager they share owns the notebooks on this machine.
    const { manager, release } = acquire(ctx.options)

    // Desktop windows drive the notebooks of this server's sessions, wherever this server runs.
    const rpc = await ctx.rpc.register(Marimo, {
      state: async () => manager.state(),
      notebooks: async ({ directory }) => [...(await manager.notebooks(directory))],
      bind: (input) => manager.bind(input),
      start: ({ id }) => manager.start(id),
      stop: async ({ id }) => (manager.stop(id), {}),
      unbind: async ({ id }) => (manager.unbind(id), {}),
      configure: async (settings) => (manager.configure(settings), {}),
    })
    const unsubscribe = manager.subscribe((state) => void rpc.events.emit("changed", state).catch(() => undefined))

    // Tell the agent which notebook is this session's, every request, so it never has to guess.
    await ctx.session.hook("context", (input) => {
      const binding = manager.view(input.sessionID)
      if (!binding) return
      // Every project's instance sees the hook; the first one to answer is enough.
      if (input.system.some((part) => part.type === "text" && part.text.startsWith(MARKER))) return
      input.system.push({ type: "text", text: instructions(binding) })
    })

    // Authenticate marimo-pair against the session's notebook without the token entering the transcript.
    await ctx.shell.hook("create.before", (input) => {
      const token = manager.tokenFor(input.command)
      if (token) input.env.MARIMO_TOKEN = token
    })

    // A deleted session releases its notebook and port; an archived one stops its marimo but keeps the notebook.
    const events = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.deleted", "session.archived"],
        signal: events.signal,
      })) {
        if (event.type === "session.deleted") manager.forget(event.data.sessionID)
        if (event.type === "session.archived") manager.archive(event.data.sessionID)
      }
    })().catch((error) => {
      if (!events.signal.aborted) console.error("[opencode-marimo] session events stopped", error)
    })

    // Sessions deleted while this server was down. Only "not found" counts as gone: a failed lookup keeps the binding.
    void manager.prune((id) =>
      ctx.session.get({ sessionID: id as never }).then(
        () => true,
        (error) => (MISSING.has((error as { _tag?: string } | null)?._tag ?? "") ? false : undefined),
      ),
    )

    return () => {
      events.abort()
      unsubscribe()
      release()
    }
  },
})
