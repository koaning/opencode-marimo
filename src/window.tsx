import {
  Command,
  ComposerPill,
  Slot,
  type MountedSession,
  type Plugin,
  type SelectOption,
  type ServerRef,
} from "@opencode/plugin/gui";
import { Browser } from "@opencode/plugin/gui/browser";
import { createEffect, createSignal } from "solid-js";
import { Binding as BindingSchema, Marimo } from "./contract";
import { MarimoLogo } from "./logo";
import type { definition } from "./definition";

type Binding = (typeof BindingSchema)["Type"];

const DOT = {
  running: "#1c9a5b",
  starting: "#d4a017",
  stopped: "#8a8a8a",
} as const;

type Choice = { readonly name: string; readonly create: boolean } | "new";

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const browser = ctx.use(Browser);
  let client: ReturnType<typeof ctx.main<typeof Marimo.spec>> | undefined;
  const marimo = () => (client ??= ctx.main(Marimo));

  const key = (session: MountedSession) => ({
    server: session.server.id,
    id: session.id,
  });
  const bindingOf = (session: MountedSession | undefined) => {
    if (!session) return undefined;
    try {
      return marimo()
        .state()
        ?.bindings.find(
          (b) => b.server === session.server.id && b.id === session.id,
        );
    } catch (error) {
      console.error("[opencode-marimo] ipc unavailable", { id: ctx.id, error });
      return undefined;
    }
  };
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

  const show = (url: string, session: MountedSession) => {
    const live = browser();
    if (live.status === "active" && live.value.canOpen(session, url))
      live.value.open(session, url);
    else ctx.system.openExternal(url);
  };

  // First use in a session: pick one of the folder's notebooks or create one. The session then owns it.
  const choose = async (directory: string) => {
    const notebooks = await marimo().notebooks(directory);
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
    input: Parameters<ReturnType<typeof marimo>["bind"]>[0],
  ) => {
    const { owner, name } = await marimo().bind(input);
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
    if (action === "go") ctx.tabs.open(owner, { focus: true });
    if (action !== "move") return undefined;
    await marimo().unbind(owner);
    const again = await marimo().bind(input);
    // Another session took it in between: leave it to the user.
    return again.owner ? undefined : again.name;
  };

  const bind = async (session: MountedSession) => {
    const choice = await choose(session.directory);
    if (!choice) return false;
    const name = await claim({
      ...key(session),
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
    try {
      if (!bindingOf(session) && !(await bind(session))) return;
      const wasRunning = bindingOf(session)?.status === "running";
      const url = await marimo().start(key(session));
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
    const choice = await choose(directory);
    if (!choice) return;

    creating = true;
    let created: { readonly server: string; readonly id: string } | undefined;
    let opened = false;
    try {
      const session = await server.client.session.create({
        location: { directory },
      });
      created = { server: server.id, id: session.id };
      const name = await claim({ ...created, directory, ...choice });
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
      entry.url = await marimo().start(created);
      changed();
    } catch (error) {
      // Before its tab opens, a half-made session is clutter: drop it. After, the session's pill can retry.
      if (created && !opened) {
        const key = created;
        await marimo()
          .unbind(key)
          .catch(() => undefined);
        await server.client.session
          .remove({ sessionID: key.id })
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
      if (session) void marimo().stop(key(session));
    },
  }));

  ctx.add(Command, (): Command => ({
    id: "unbind",
    title: ctx.t("command.unbind"),
    keywords: "marimo notebook python release",
    enabled: !!bindingOf(current()),
    run: () => {
      const session = current();
      if (session) void marimo().unbind(key(session));
    },
  }));

  const statusLabel = (binding: Binding) =>
    `${fileName(binding.name)} · ${ctx.t(`status.${binding.status}`)}`;

  // Starts the notebook if needed and asks the agent to connect to it.
  const pairAgent = async (session: MountedSession) => {
    try {
      await connect(session, await marimo().start(key(session)));
    } catch (error) {
      ctx.toast.show({
        variant: "error",
        title: ctx.t("failed"),
        description: String(error),
      });
    }
  };

  // A pill above every session's composer: status at a glance, and the notebook's actions.
  ctx.add(ComposerPill, {
    id: "marimo",
    show: (input) => {
      const session = input.session;
      const binding = bindingOf(session);
      if (!binding)
        return {
          label: ctx.t("button.open"),
          icon: "flask",
          title: ctx.t("pill.start"),
          run: () => void open(session),
        };
      const running = binding.status === "running";
      return {
        label: statusLabel(binding),
        icon: running ? "status-active" : "flask",
        tone: running
          ? "success"
          : binding.status === "starting"
            ? "warning"
            : undefined,
        title: binding.name,
        rows: [
          {
            id: "show",
            label: ctx.t(running ? "pill.show" : "pill.startShow"),
            icon: "globe",
            run: () => void open(session),
          },
          {
            id: "pair",
            label: ctx.t("pill.pair"),
            icon: "link",
            run: () => void pairAgent(session),
          },
          ...(running
            ? [
                {
                  id: "stop",
                  label: ctx.t("command.stop"),
                  icon: "stop" as const,
                  run: () => void marimo().stop(key(session)),
                },
              ]
            : []),
          {
            id: "release",
            label: ctx.t("command.unbind"),
            icon: "close" as const,
            run: () => void marimo().unbind(key(session)),
          },
        ],
      };
    },
  });

  // A button in every session's header, bound to that session and its notebook, with a status dot.
  ctx.add(Slot, {
    at: "session.header",
    render: (input) => {
      const binding = () => bindingOf(input.session);
      return (
        <ctx.ui.Button
          size="small"
          variant="ghost"
          busy={binding()?.status === "starting"}
          onClick={() => void open(input.session)}
        >
          <span
            title={binding() ? ctx.t(`status.${binding()!.status}`) : undefined}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "6px",
            }}
          >
            <MarimoLogo size={14} />
            {binding() ? statusLabel(binding()!) : ctx.t("button.open")}
            {binding() && (
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  background: DOT[binding()!.status],
                  "box-shadow":
                    binding()!.status === "running"
                      ? `0 0 0 2px ${DOT.running}33`
                      : "none",
                }}
              />
            )}
          </span>
        </ctx.ui.Button>
      );
    },
  });
};
