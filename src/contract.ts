import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/** A session, as `{ server, id }` from its `SessionRef`. */
export const SessionKey = Schema.Struct({ server: Schema.String, id: Schema.String })

/** The one notebook a session owns, with the one port (and URL) it is served on. */
export const Binding = Schema.Struct({
  server: Schema.String,
  id: Schema.String,
  /** Notebook path relative to the session's directory. */
  name: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["stopped", "starting", "running"]),
})

/** Bridge between the main process (owns bindings and `marimo edit` processes) and every window. */
export const Marimo = Ipc.define({
  id: "opencode-marimo.server",
  state: Schema.Struct({ bindings: Schema.Array(Binding) }),
  methods: {
    /** marimo notebooks under a directory, relative to it. */
    notebooks: { input: Schema.String, output: Schema.Array(Schema.String) },
    /** Binds a notebook to a session; `name` is the normalized relative path. `owner` is set instead when another session owns it. */
    bind: {
      input: Schema.Struct({
        server: Schema.String,
        id: Schema.String,
        directory: Schema.String,
        name: Schema.String,
        create: Schema.Boolean,
      }),
      output: Schema.Struct({ owner: Schema.NullOr(SessionKey), name: Schema.String }),
    },
    /** Starts the session's notebook if needed; resolves with its URL once marimo serves it. */
    start: { input: SessionKey, output: Schema.String },
    stop: { input: SessionKey },
    /** Stops the session's notebook and releases the notebook and its port. */
    unbind: { input: SessionKey },
  },
})
