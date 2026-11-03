import { Plugin } from "@opencode/plugin/gui";

export const definition = Plugin.define({
  i18n: {
    en: {
      "command.open": "Open marimo notebook",
      "command.stop": "Stop marimo notebook",
      "command.unbind": "Release marimo notebook",
      "command.new": "New marimo session",
      "button.open": "marimo",
      "folder.title": "Pick a folder for the new session",
      "folder.placeholder": "Search projects",
      "folder.group": "Projects",
      "folder.pick": "Choose another folder…",
      "choose.title": "Pick this session's notebook",
      "choose.placeholder": "Search notebooks",
      "choose.group": "Notebooks in this folder",
      "choose.new": "New notebook…",
      "new.title": "Notebook file name",
      "owned.title": "{{name}} belongs to another session",
      "owned.move": "Move it to this session",
      "owned.move.description":
        "The other session lets go of it and its marimo server stops",
      "owned.go": "Go to that session",
      nosession:
        "Send a message first: marimo binds to a session once it exists",
      noserver: "No OpenCode server is connected",
      failed: "marimo failed to start",
      "connect.text": [
        "Use the /marimo-pair skill to pair-program on a running marimo notebook.",
        "",
        "Connect to the notebook at: {{url}}",
        "",
        "Use `execute-code.sh --url {{url}}` from the marimo-pair skill to execute code in the notebook.",
        "",
        "Use this auth token when calling `execute-code.sh`: `execute-code.sh --url {{url}} --token {{token}}`.",
        "",
        "Once you are connected, send a fun toast (mo.status.toast(...)) to the user inside marimo letting them know you're ready to pair.",
      ].join("\n"),
      "pill.start": "Pick a marimo notebook for this session",
      "pill.show": "Show notebook",
      "pill.startShow": "Start and show notebook",
      "pill.pair": "Pair the agent with this notebook",
      "status.running": "running",
      "status.starting": "starting…",
      "status.stopped": "stopped",
    },
  },
});
