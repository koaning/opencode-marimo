import { homedir } from "node:os"
import { join } from "node:path"

/**
 * What the desktop main process publishes for the server part: each session's notebook, port, token and status.
 * Keyed by session id. The file is private to the user (0600) because it holds the notebooks' access tokens.
 */
export interface Published {
  readonly [sessionID: string]: {
    readonly notebook: string
    readonly directory: string
    readonly port: number
    readonly token: string
    readonly status: "stopped" | "starting" | "running"
  }
}

export const PUBLISHED_FILE = join(homedir(), ".local", "state", "opencode-marimo", "sessions.json")
