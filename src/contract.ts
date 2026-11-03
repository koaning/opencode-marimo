import { Schema } from "effect"
import type { Rpc } from "@opencode/plugin/rpc"

// RPC schemas must be portable (Standard Schema); Effect schemas become one without losing their types.
const portable = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(schema)

/** What the user sets in Settings → marimo. Applies the next time a notebook starts. */
export const Settings = Schema.Struct({
  /** Launch notebooks through marimo-studio (Notebook + Preview views). */
  studio: Schema.Boolean,
  /** The marimo-studio requirement uv installs, e.g. `marimo-studio==0.4.2`. Empty means the latest. */
  requirement: Schema.String,
})

/** The one notebook a session owns, with the one port (and URL) it is served on, on the session's server. */
export const Binding = Schema.Struct({
  /** The session's id on its server. */
  id: Schema.String,
  /** Notebook path relative to the session's directory. */
  name: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["stopped", "starting", "running"]),
})

export const State = Schema.Struct({ bindings: Schema.Array(Binding), settings: Settings })

const Session = Schema.Struct({ id: Schema.String })
const Empty = Schema.Struct({})

/**
 * Between every Desktop window and the plugin's server part, which owns the bindings and `marimo edit` processes on
 * the machine that runs that OpenCode server: this one, or one reached over SSH.
 */
export const Marimo = {
  id: "opencode-marimo",
  methods: {
    state: { input: portable(Empty), output: portable(State) },
    /** marimo notebooks under a directory, relative to it. */
    notebooks: { input: portable(Schema.Struct({ directory: Schema.String })), output: portable(Schema.Array(Schema.String)) },
    /** Binds a notebook to a session; `name` is the normalized relative path. `owner` is set instead when another session owns it. */
    bind: {
      input: portable(
        Schema.Struct({ id: Schema.String, directory: Schema.String, name: Schema.String, create: Schema.Boolean }),
      ),
      output: portable(Schema.Struct({ owner: Schema.NullOr(Schema.String), name: Schema.String })),
    },
    /** Starts the session's notebook if needed; resolves with its URL once marimo serves it. */
    start: { input: portable(Session), output: portable(Schema.String) },
    stop: { input: portable(Session), output: portable(Empty) },
    /** Stops the session's notebook and releases the notebook and its port. */
    unbind: { input: portable(Session), output: portable(Empty) },
    configure: { input: portable(Settings), output: portable(Empty) },
  },
  events: {
    changed: { schema: portable(State) },
  },
} as const satisfies Rpc.PortableDefinition
