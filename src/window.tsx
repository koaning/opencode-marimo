import {
  Command,
  Slot,
  type MountedSession,
  type Plugin,
  type SelectOption,
  type ServerRef,
  SettingsPage,
} from "@opencode/plugin/gui";
import { Browser } from "@opencode/plugin/gui/browser";
import { createEffect, createSignal, Show, type JSX } from "solid-js";
import {
  Binding as BindingSchema,
  Marimo,
  Settings as SettingsSchema,
  State as StateSchema,
} from "./contract";
import { MarimoLogo } from "./logo";
import type { definition } from "./definition";

type Binding = (typeof BindingSchema)["Type"];
type Settings = (typeof SettingsSchema)["Type"];
type State = (typeof StateSchema)["Type"];
type Client = ServerRef["client"];

type Choice = { readonly name: string; readonly create: boolean } | "new";

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const browser = ctx.use(Browser);

  // Each server runs its own notebooks: its plugin part answers for its sessions, here or over SSH. Its state, or
  // "unavailable" when that server doesn't run this plugin, by `ServerRef.id`.
  const [states, setStates] = createSignal<
    Readonly<Record<string, State | "unavailable">>
  >({});
  const followed = new Map<
    string,
    { client: Client; stop: AbortController; offline?: boolean }
  >();
  const api = (server: ServerRef) => server.client.rpc(Marimo);
  // Calls about a session go to its project's instance of the plugin.
  const at = (session: MountedSession) => ({
    location: { directory: session.directory },
  });

  const put = (server: ServerRef, value: State | "unavailable") => {
    if (followed.get(server.id)?.client === server.client)
      setStates((all) => ({ ...all, [server.id]: value }));
  };
  // Asks the server again. "unavailable" is only what it said last time: its plugin may have loaded since.
  const refresh = (server: ServerRef) =>
    api(server)
      .state({})
      .then(
        (state) => put(server, state),
        (error) => {
          console.warn("[opencode-marimo] no marimo on server", {
            server: server.name,
            error: String(error),
          });
          put(server, "unavailable");
        },
      );

  const follow = (server: ServerRef) => {
    const known = followed.get(server.id);
    if (known?.client === server.client) {
      // Back from a dropped connection: it may have missed changes, or restarted its plugin.
      if (known.offline) {
        known.offline = false;
        void refresh(server);
      }
      return;
    }
    // A restarted server comes with a new client: follow that one instead.
    known?.stop.abort();
    const stop = new AbortController();
    followed.set(server.id, { client: server.client, stop });
    api(server).events.on("changed", (event) => put(server, event.data), {
      signal: stop.signal,
    });
    void refresh(server);
  };
  createEffect(() => {
    for (const id of ctx.servers.list()) {
      const server = ctx.servers.get(id);
      if (!server) continue;
      if (server.connected && server.compatible) follow(server);
      else {
        const known = followed.get(id);
        if (known) known.offline = true;
      }
    }
  });
  ctx.signal.addEventListener("abort", () => {
    for (const { stop } of followed.values()) stop.abort();
  });

  const stateOf = (server: ServerRef | undefined) => {
    const state = server && states()[server.id];
    return state === "unavailable" ? undefined : state;
  };
  const unavailable = (server: ServerRef) =>
    states()[server.id] === "unavailable";
  const bindingOf = (session: MountedSession | undefined) =>
    session &&
    stateOf(session.server)?.bindings.find((b) => b.id === session.id);
  // Settings → marimo edits the notebooks this app's own server runs.
  const settings = (): Settings =>
    stateOf(localServer())?.settings ?? { studio: false, requirement: "", idle: 30 };
  const current = () => ctx.sessions.current();
  const fileName = (path: string) => path.split("/").pop() ?? path;
  // Sessions "New marimo session" created, by `SessionRef.key`, until their tab mounts.
  const pending = new Map<
    string,
    { readonly file: string; url?: string; attached?: boolean }
  >();
  const [revision, setRevision] = createSignal(0);
  const changed = () => setRevision((value) => value + 1);
  let creating = false;

  // The pane reaches a notebook on the session's machine; the system browser only reaches one on this machine.
  const show = (url: string, session: MountedSession) => {
    const live = browser();
    // `canOpen` only says yes for this app's own server (it vets workspace files); a remote session's pane still
    // opens URLs, and loads localhost from the session's machine.
    const pane =
      live.status === "active" &&
      (live.value.canOpen(session, url) ||
        (!session.server.local && live.value.attached(session)));
    if (pane) live.value.open(session, url);
    else if (session.server.local) ctx.system.openExternal(url);
    else ctx.toast.show({ variant: "error", title: ctx.t("nopane") });
  };

  // First use in a session: pick one of the folder's notebooks or create one. The session then owns it.
  const choose = async (server: ServerRef, directory: string) => {
    const notebooks = await api(server).notebooks(
      { directory },
      { location: { directory } },
    );
    const choice = await ctx.dialogs.select<Choice>({
      title: ctx.t("choose.title"),
      placeholder: ctx.t("choose.placeholder"),
      options: [
        { title: ctx.t("choose.new"), value: "new" },
        ...notebooks.map((name) => ({
          title: name,
          value: { name, create: false },
          group: ctx.t("choose.group"),
        })),
      ],
    });
    if (choice !== "new") return choice;
    const name = await ctx.dialogs.prompt({
      title: ctx.t("new.title"),
      placeholder: "analysis.py",
      value: "notebook.py",
    });
    return name?.trim() ? { name: name.trim(), create: true } : undefined;
  };

  // Binds a notebook to a session. A notebook has one session, and old sessions keep theirs: when another session
  // holds it, offer to move it here (that session's marimo stops) or to go there. Resolves with the notebook's name,
  // or undefined when the user did neither.
  const claim = async (
    server: ServerRef,
    input: { id: string; directory: string; name: string; create: boolean },
  ) => {
    const rpc = api(server);
    const location = { location: { directory: input.directory } };
    const { owner, name } = await rpc.bind(input, location);
    if (!owner) return name;
    const action = await ctx.dialogs.select<"move" | "go">({
      title: ctx.t("owned.title", { name }),
      options: [
        {
          title: ctx.t("owned.move"),
          description: ctx.t("owned.move.description"),
          value: "move",
        },
        { title: ctx.t("owned.go"), value: "go" },
      ],
    });
    if (action === "go")
      ctx.tabs.open({ server: server.id, id: owner }, { focus: true });
    if (action !== "move") return undefined;
    await rpc.unbind({ id: owner }, location);
    const again = await rpc.bind(input, location);
    // Another session took it in between: leave it to the user.
    return again.owner ? undefined : again.name;
  };

  const bind = async (session: MountedSession) => {
    const choice = await choose(session.server, session.directory);
    if (!choice) return false;
    const name = await claim(session.server, {
      id: session.id,
      directory: session.directory,
      ...choice,
    });
    if (!name) return false;
    // Tell the agent which notebook this session works on.
    ctx.screen.current()?.composer.attach({ type: "file", path: name });
    return true;
  };

  // Sends the pairing prompt (same shape as molab's) as a real message, with the marimo-pair skill attached, so the
  // agent connects right away and confirms with a toast inside marimo.
  const connect = async (session: MountedSession, url: string) => {
    const parsed = new URL(url);
    const params = {
      url: `${parsed.origin}/`,
      token: parsed.searchParams.get("access_token") ?? "",
    };
    const prompt = session.server.client.session.prompt;
    // Fill the placeholders ourselves: the template repeats {{url}}.
    const text = ctx
      .t("connect.text")
      .replaceAll("{{url}}", params.url)
      .replaceAll("{{token}}", params.token);
    const input = { sessionID: session.id, text, metadata: { plugin: ctx.id } };
    // Skill ids are branded strings in the client types; "marimo-pair" is the skill's id.
    const skills = [{ id: "marimo-pair" }] as unknown as Parameters<
      typeof prompt
    >[0]["skills"];
    try {
      await prompt({ ...input, skills });
    } catch (error) {
      // Without the skill installed the agent still gets the URL from the server part.
      console.warn(
        "[opencode-marimo] prompt with marimo-pair failed, retrying without it",
        error,
      );
      await prompt(input);
    }
  };

  const open = async (session = current()) => {
    if (!session) return startNew();
    if (session.pending) {
      ctx.toast.show({ title: ctx.t("nosession") });
      return;
    }
    if (unavailable(session.server)) await refresh(session.server);
    if (unavailable(session.server)) {
      ctx.toast.show({
        variant: "error",
        title: ctx.t("unavailable", { server: session.server.name }),
        description: ctx.t("unavailable.description"),
      });
      return;
    }
    try {
      if (!bindingOf(session) && !(await bind(session))) return;
      const wasRunning = bindingOf(session)?.status === "running";
      const url = await api(session.server).start(
        { id: session.id },
        at(session),
      );
      show(url, session);
      if (!wasRunning) await connect(session, url);
    } catch (error) {
      ctx.toast.show({
        variant: "error",
        title: ctx.t("failed"),
        description: String(error),
      });
    }
  };

  // The app's own server when it is up, else the first one that works with this app.
  const localServer = () => {
    const servers = ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .filter(
        (server): server is ServerRef =>
          !!server && server.connected && server.compatible,
      );
    return servers.find((server) => server.builtin) ?? servers[0];
  };

  // The landing page keeps its folder to itself, so ask: the server's projects, most recently active first.
  const chooseFolder = async (server: ServerRef) => {
    if (server.data.project.list().length === 0)
      await server.data.project.sync();
    const projects = server.data.project
      .list()
      .filter((project) => !project.time.archived)
      .sort((a, b) => b.time.active - a.time.active);
    // `null` stands for the system folder picker.
    const options: SelectOption<string | null>[] = projects.map((project) => ({
      title: project.name ?? fileName(project.canonical),
      description: project.canonical,
      value: project.canonical,
      group: ctx.t("folder.group"),
    }));
    if (ctx.desktop) options.push({ title: ctx.t("folder.pick"), value: null });
    const folder = await ctx.dialogs.select<string | null>({
      title: ctx.t("folder.title"),
      placeholder: ctx.t("folder.placeholder"),
      options,
    });
    if (folder !== null) return folder;
    const [picked] =
      (await ctx.desktop?.pick({
        directory: true,
        title: ctx.t("folder.title"),
      })) ?? [];
    return picked;
  };

  // A fresh session that owns a running notebook before anything is sent, so the user's first prompt is a real one.
  const startNew = async () => {
    if (creating) return;
    const server = localServer();
    if (!server) {
      ctx.toast.show({ variant: "error", title: ctx.t("noserver") });
      return;
    }
    const directory = await chooseFolder(server);
    if (!directory) return;
    const choice = await choose(server, directory);
    if (!choice) return;

    creating = true;
    let created: { readonly server: string; readonly id: string } | undefined;
    let opened = false;
    try {
      const session = await server.client.session.create({
        location: { directory },
      });
      created = { server: server.id, id: session.id };
      const name = await claim(server, {
        id: session.id,
        directory,
        ...choice,
      });
      if (!name) {
        created = undefined;
        await server.client.session.remove({ sessionID: session.id });
        return;
      }

      const entry: { readonly file: string; url?: string } = { file: name };
      pending.set(`${created.server}\n${created.id}`, entry);
      changed();
      ctx.tabs.open(created, { focus: true });
      opened = true;
      entry.url = await api(server).start(
        { id: session.id },
        { location: { directory } },
      );
      changed();
    } catch (error) {
      // Before its tab opens, a half-made session is clutter: drop it. After, the session's pill can retry.
      if (created && !opened) {
        const id = created.id;
        await api(server)
          .unbind({ id }, { location: { directory } })
          .catch(() => undefined);
        await server.client.session
          .remove({ sessionID: id })
          .catch(() => undefined);
      }
      ctx.toast.show({
        variant: "error",
        title: ctx.t("failed"),
        description: String(error),
      });
    } finally {
      creating = false;
    }
  };

  // Once a session `startNew` made is on screen: attach its notebook to the composer, show marimo, and send the
  // pairing prompt as the session's first message, as opening marimo in a session does.
  createEffect(() => {
    revision();
    const session = current();
    const next = session && pending.get(session.key);
    if (!session || !next) return;
    if (!next.attached) {
      const composer = ctx.screen.current()?.composer;
      if (!composer) return;
      composer.attach({ type: "file", path: next.file });
      composer.focus();
      next.attached = true;
    }
    if (!next.url) return;
    pending.delete(session.key);
    show(next.url, session);
    connect(session, next.url).catch((error) =>
      ctx.toast.show({
        variant: "error",
        title: ctx.t("failed"),
        description: String(error),
      }),
    );
  });

  ctx.add(Command, (): Command => ({
    id: "new",
    title: ctx.t("command.new"),
    keywords: "marimo notebook python session",
    featured: true,
    run: () => void startNew(),
  }));

  ctx.add(Command, (): Command => ({
    id: "open",
    title: ctx.t("command.open"),
    keywords: "marimo notebook python",
    slash: { name: "marimo" },
    // Opening acts on whichever session is routed, which reads badly in the palette: only `/marimo` offers it.
    hidden: true,
    run: () => void open(),
  }));

  ctx.add(Command, (): Command => ({
    id: "stop",
    title: ctx.t("command.stop"),
    keywords: "marimo notebook python",
    enabled: bindingOf(current())?.status === "running",
    run: () => {
      const session = current();
      if (session) void api(session.server).stop({ id: session.id }, at(session));
    },
  }));

  ctx.add(Command, (): Command => ({
    id: "unbind",
    title: ctx.t("command.unbind"),
    keywords: "marimo notebook python release",
    enabled: !!bindingOf(current()),
    run: () => {
      const session = current();
      if (session)
        void api(session.server).unbind({ id: session.id }, at(session));
    },
  }));

  ctx.add(Command, (): Command => ({
    id: "settings",
    title: ctx.t("command.settings"),
    keywords: "marimo notebook studio settings preferences",
    run: () => ctx.layout.settings("opencode-marimo"),
  }));

  // Its own page in Settings, so `layout.settings` can open it. main owns the value, so every window shows the same.
  ctx.add(SettingsPage, {
    id: "opencode-marimo",
    icon: "flask",
    title: ctx.t("settings.title"),
    entries: [
      {
        id: "opencode-marimo",
        title: ctx.t("settings.title"),
        keywords: "marimo notebook python",
      },
      {
        id: "marimo-studio",
        title: ctx.t("settings.studio"),
        description: ctx.t("settings.studio.description"),
        keywords: "marimo studio views preview reports slides",
      },
    ],
    render: () => {
      // What the user typed, so IPC round trips on every keystroke can't move the caret. Until then, the saved value.
      const [draft, setDraft] = createSignal<string>();
      const [idleDraft, setIdleDraft] = createSignal<string>();
      const configure = (next: Partial<Settings>) => {
        const server = localServer();
        if (server) void api(server).configure({ ...settings(), ...next });
      };
      return (
        <>
          <div class="settings-tab-header">
            <div class="settings-tab-header-row">
              <div class="flex flex-col gap-1">
                <h2 class="settings-tab-title">{ctx.t("settings.title")}</h2>
                <span class="text-11-regular text-v2-text-text-muted">
                  {ctx.t("settings.description")}
                </span>
              </div>
            </div>
          </div>
          <div class="settings-tab-body settings-tab-body--sectioned">
            <section class="settings-section" aria-label={ctx.t("settings.title")}>
              <div data-component="settings-list">
                <div data-action="marimo-studio">
                  <Row
                    title={ctx.t("settings.studio")}
                    description={ctx.t("settings.studio.description")}
                  >
                    <ctx.ui.Switch
                      label={ctx.t("settings.studio")}
                      hideLabel
                      checked={settings().studio}
                      onChange={(studio) => configure({ studio })}
                    />
                  </Row>
                </div>
                <Show when={settings().studio}>
                  <Row
                    title={ctx.t("settings.version")}
                    description={ctx.t("settings.version.description")}
                  >
                    <ctx.ui.TextInput
                      label={ctx.t("settings.version")}
                      placeholder="marimo-studio"
                      value={draft() ?? settings().requirement}
                      onInput={(requirement) => {
                        setDraft(requirement);
                        configure({ requirement });
                      }}
                    />
                  </Row>
                </Show>
                <Row
                  title={ctx.t("settings.idle")}
                  description={ctx.t("settings.idle.description")}
                >
                  <ctx.ui.TextInput
                    label={ctx.t("settings.idle")}
                    placeholder="30"
                    value={idleDraft() ?? String(settings().idle)}
                    onInput={(value) => {
                      setIdleDraft(value);
                      // Whole minutes; anything else waits until the field holds one.
                      if (/^\d+$/.test(value.trim()))
                        configure({ idle: Number(value.trim()) });
                    }}
                  />
                </Row>
              </div>
            </section>
          </div>
        </>
      );
    },
  });

  const statusLabel = (binding: Binding) =>
    `${fileName(binding.name)} · ${ctx.t(`status.${binding.status}`)}`;

  // Starts the notebook if needed and asks the agent to connect to it.
  const pairAgent = async (session: MountedSession) => {
    try {
      await connect(
        session,
        await api(session.server).start({ id: session.id }, at(session)),
      );
    } catch (error) {
      ctx.toast.show({
        variant: "error",
        title: ctx.t("failed"),
        description: String(error),
      });
    }
  };

  // The session header is the notebook's single control: it opens the picker before binding, then owns every action.
  ctx.add(Slot, {
    at: "session.header",
    render: (input) => {
      const binding = () => bindingOf(input.session);
      return (
        <Show
          when={binding()}
          fallback={
            <ctx.ui.Button
              size="small"
              variant="ghost"
              onClick={() => void open(input.session)}
            >
              <span
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "6px",
                }}
              >
                <MarimoLogo size={14} />
                {ctx.t("button.open")}
              </span>
            </ctx.ui.Button>
          }
        >
          {(active) => (
            <ctx.ui.Menu
              label={statusLabel(active())}
              trigger="button"
              icon={active().status === "running" ? "status-active" : "flask"}
              placement="bottom-end"
              items={[
                {
                  label: ctx.t(
                    active().status === "running"
                      ? "pill.show"
                      : "pill.startShow",
                  ),
                  icon: "globe",
                  onSelect: () => void open(input.session),
                },
                {
                  label: ctx.t("pill.pair"),
                  icon: "link",
                  onSelect: () => void pairAgent(input.session),
                },
                ...(active().status === "running"
                  ? [
                      {
                        label: ctx.t("command.stop"),
                        icon: "stop" as const,
                        onSelect: () =>
                          void api(input.session.server).stop(
                            { id: input.session.id },
                            at(input.session),
                          ),
                      },
                    ]
                  : []),
                {
                  label: ctx.t("command.unbind"),
                  icon: "close" as const,
                  onSelect: () =>
                    void api(input.session.server).unbind(
                      { id: input.session.id },
                      at(input.session),
                    ),
                },
              ]}
            />
          )}
        </Show>
      );
    },
  });
};

// The host's settings row markup; its stylesheet is loaded with the settings screen.
function Row(props: {
  title: string;
  description: string;
  children: JSX.Element;
}) {
  return (
    <div data-component="settings-row">
      <div data-slot="settings-row-copy">
        <div data-slot="settings-row-title">{props.title}</div>
        <div data-slot="settings-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-row-control">{props.children}</div>
    </div>
  );
}
