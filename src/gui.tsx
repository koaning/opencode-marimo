import { Plugin } from "@opencode/plugin/gui"
import { definition } from "./definition"
import { setup } from "./window"

// Only windows: marimo itself runs in the server part, on whichever machine runs each session's server.
export default Plugin.define({ ...definition, setup })
