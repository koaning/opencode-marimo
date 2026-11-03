import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { PUBLISHED_FILE, type Published } from "./published"

const read = (): Published => {
  try {
    return JSON.parse(readFileSync(PUBLISHED_FILE, "utf8"))
  } catch {
    return {}
  }
}

const instructions = (b: Published[string]) => {
  const url = `http://localhost:${b.port}`
  return [
    `This session owns one marimo notebook: ${b.notebook}, served at ${url} (currently ${b.status}).`,
    `When the user talks about "the notebook" or asks you to work in marimo, pair with this server only.`,
    `Do not run discover-servers.sh or look for other marimo servers: other servers on this machine belong to other work.`,
    `Use the marimo-pair skill's execute-code.sh with --url ${url}/. MARIMO_TOKEN is added to the environment automatically`,
    `for shell commands that mention ${url}, so --token is optional.`,
    `The notebook runs with --watch (edits to the file reload) and --sandbox (dependencies live in its PEP 723 header).`,
    b.status === "running"
      ? `marimo-pair needs the notebook open in an editor; the user has it in OpenCode's side pane.`
      : `It is not running right now: ask the user to start it from the marimo pill above the message box.`,
  ].join(" ")
}

export default Plugin.define({
  id: "opencode-marimo",
  async setup(ctx) {
    // Tell the agent which notebook is this session's, every request, so it never has to guess.
    await ctx.session.hook("context", (input) => {
      const binding = read()[input.sessionID]
      if (binding) input.system.push({ type: "text", text: instructions(binding) })
    })

    // Authenticate marimo-pair against the session's notebook without the token entering the transcript.
    await ctx.shell.hook("create.before", (input) => {
      for (const b of Object.values(read())) {
        if (input.command.includes(`localhost:${b.port}`) || input.command.includes(`127.0.0.1:${b.port}`)) {
          input.env.MARIMO_TOKEN = b.token
          return
        }
      }
    })
  },
})
