window.__ModuleLoader__.load({
  id: "dsh-local-plugins",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var name = "dsh-local-plugins";
var inject = ["slots", "remote", "remote.agentPresets"];
var API = "/local-plugins-api";
var SECTION_ID = "local-plugins";
var SECTION_LABEL = "Local Plugins";
async function call(action, body = {}, { timeoutMs = 15e3 } = {}) {
  const res = await fetch(`${API}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal: AbortSignal.timeout(timeoutMs)
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${action}: HTTP ${res.status}`);
  }
  if (!data.ok) throw new Error(data.error ?? `${action} failed`);
  return data.value;
}
function createStateStore() {
  let snapshot = null;
  let error = null;
  const listeners = /* @__PURE__ */ new Set();
  let timer = null;
  let inflight = false;
  const emit = () => {
    for (const l of listeners) l();
  };
  async function refresh() {
    if (inflight) return;
    inflight = true;
    try {
      snapshot = await call("state");
      error = null;
    } catch (err) {
      error = err.message;
    }
    inflight = false;
    emit();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!listeners.size) return;
    timer = setTimeout(refresh, snapshot?.op ? 1e3 : 15e3);
  }
  return {
    get: () => ({ snapshot, error }),
    refresh,
    subscribe(l) {
      listeners.add(l);
      if (listeners.size === 1) refresh();
      return () => {
        listeners.delete(l);
        if (!listeners.size) clearTimeout(timer);
      };
    }
  };
}
function useStore(store) {
  const [, force] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get();
}
function attentionCount(s) {
  if (!s) return 0;
  let n = s.restartNeeded ? 1 : 0;
  if (s.upgrade) n++;
  for (const p of s.plugins) if (p.pending || p.update?.available) n++;
  return n;
}
async function openAgentSession(ctx, { path, text }) {
  const workspaces = ctx.get("workspaces");
  const sessions = ctx.get("sessions");
  const ws = await workspaces.create({ path });
  const sid = await sessions.create({ workspaceId: ws.workspaceId });
  try {
    const r = await ctx.remote.agentPresets.select(sid, "standard");
    if (r && r.ok === false) console.warn("[dsh-local-plugins] preset select refused", r.error);
  } catch (err) {
    console.warn("[dsh-local-plugins] preset select failed", err);
  }
  ctx.get("uiWorkspace").openSession(sid);
  ctx.get("conversation").input.for(sessions.scope(sid)).setDraft(text);
  return sid;
}
var c = {
  muted: { color: "var(--dsw-alias-label-tertiary,#8b93a1)", fontSize: 12, lineHeight: 1.5 },
  card: { border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 12, padding: "12px 14px", marginTop: 10, background: "var(--dsw-alias-bg-layer-1,#fff)" },
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  banner: (tone) => ({
    borderLeft: `4px solid ${tone === "warn" ? "var(--dsw-alias-state-warn-primary,#b45309)" : tone === "error" ? "var(--dsw-alias-state-error-primary,#dc2626)" : "var(--dsw-alias-brand-primary,#4f6ef7)"}`,
    background: "var(--dsw-alias-bg-layer-2,#f3f4f6)",
    borderRadius: 8,
    padding: "10px 12px",
    marginTop: 10,
    fontSize: 13,
    lineHeight: 1.5
  }),
  pre: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, lineHeight: 1.45, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--dsw-alias-bg-layer-2,#f3f4f6)", borderRadius: 8, padding: 8, margin: "8px 0 0" },
  input: { font: "inherit", fontSize: 13, height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2,#d1d5db)", background: "var(--dsw-alias-bg-layer-1,#fff)", color: "var(--dsw-alias-label-primary,inherit)", boxSizing: "border-box" },
  mono: { fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12 },
  list: { maxHeight: 260, overflow: "auto", border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)", borderRadius: 8, marginTop: 8 },
  listItem: (active) => ({ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 10px", cursor: "pointer", fontSize: 13, background: active ? "var(--dsw-specific-sidebar-nav-item-active,#eef2ff)" : "transparent" })
};
var short = (sha) => sha ? String(sha).slice(0, 12) : "\u2014";
function tilde(str, home) {
  if (!str || !home) return str;
  let out = String(str);
  out = out.split(home).join("~");
  out = out.replace(/file:\/\/[^/]+\/~/g, "file://~/");
  return out;
}
function useAction(store, setNotice) {
  return (0, import_react.useCallback)(async (action, body, okText) => {
    try {
      await call(action, body);
      if (okText) setNotice({ tone: "info", text: okText });
    } catch (err) {
      setNotice({ tone: "error", text: err.message });
    }
    store.refresh();
  }, [store, setNotice]);
}
function OpPanel({ op, lastOp }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const shown = op ?? (lastOp?.status === "error" || open ? lastOp : null);
  const ref = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  if (!shown && !lastOp) return null;
  if (!shown) {
    return (0, import_react.createElement)(
      "div",
      { style: { ...c.muted, marginTop: 10 } },
      `Last: ${lastOp.kind}${lastOp.target ? ` ${lastOp.target}` : ""} \u2014 ${lastOp.status} `,
      (0, import_react.createElement)("button", { style: { border: "none", background: "none", cursor: "pointer", color: "inherit", textDecoration: "underline", padding: 0, fontSize: 12 }, onClick: () => setOpen(true) }, "show log")
    );
  }
  const tone = shown.status === "error" ? "error" : shown.status === "running" ? "info" : "info";
  return (0, import_react.createElement)(
    "div",
    { style: c.banner(tone), "data-testid": "lp-op" },
    (0, import_react.createElement)(
      "div",
      { style: c.row },
      (0, import_react.createElement)("strong", null, shown.status === "running" ? "\u23F3 Running: " : shown.status === "error" ? "\u2716 Failed: " : "\u2714 Done: "),
      (0, import_react.createElement)("span", null, `${shown.kind}${shown.target ? ` ${shown.target}` : ""}`),
      !op && (0, import_react.createElement)("button", { style: { marginLeft: "auto", border: "none", background: "none", cursor: "pointer", color: "inherit", fontSize: 12 }, onClick: () => setOpen(false) }, "hide")
    ),
    shown.error && (0, import_react.createElement)("div", { style: { marginTop: 4 } }, shown.error),
    (0, import_react.createElement)("pre", { ref, style: c.pre }, shown.log.slice(-200).join("\n"))
  );
}
function PluginCard({ p, run, busy, ctx, close, openModal, homePath }) {
  const stats = p.stats ?? {};
  const state = p.applied ? p.linkLost ? "Link lost" : "Applied" : "Tracked only";
  const tone = p.applied ? p.linkLost ? "warning" : "success" : "neutral";
  const [agentErr, setAgentErr] = (0, import_react.useState)(null);
  async function agent(mode) {
    setAgentErr(null);
    try {
      const draft = await call("agentDraft", { name: p.name, mode });
      close?.();
      await openAgentSession(ctx, draft);
    } catch (err) {
      setAgentErr(err.message);
    }
  }
  return (0, import_react.createElement)(
    "div",
    { style: c.card, "data-testid": `lp-card-${p.name}` },
    (0, import_react.createElement)(
      "div",
      { style: c.row },
      (0, import_react.createElement)("strong", { style: { fontSize: 14 } }, p.name),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: p.kind === "core" ? "info" : "outline" }, p.kind === "core" ? "core" : "third-party"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone }, state),
      p.update?.available && !p.pending && (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "warning" }, `Update available ${p.update.target && p.update.target !== "upstream" ? short(p.update.target) : ""}`),
      p.pending && (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "danger" }, "Conflict")
    ),
    (0, import_react.createElement)("div", { style: { ...c.muted, marginTop: 4 } }, p.source.type === "git" ? `git \xB7 ${tilde(p.source.url, homePath)}` : `npm \xB7 ${p.source.name}`),
    (0, import_react.createElement)(
      "div",
      { style: { fontSize: 12, marginTop: 6, lineHeight: 1.6 } },
      (0, import_react.createElement)("span", { "data-testid": "lp-changed" }, `${stats.changedVsOriginal ?? "?"} file(s) changed vs original`),
      stats.uncommitted ? (0, import_react.createElement)("span", null, ` \xB7 ${stats.uncommitted} uncommitted`) : null,
      " \xB7 ",
      p.applied ? (0, import_react.createElement)("span", { "data-testid": "lp-running" }, `running ${short(p.deployedSha)}${stats.notApplied ? ` \xB7 ${stats.notApplied} newer commit(s) not applied` : ""}`) : (0, import_react.createElement)("span", null, `local ${short(stats.head)}`),
      p.update?.error ? (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, `update check failed: ${p.update.error}`) : null,
      p.lastError ? (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, `last error: ${p.lastError}`) : null
    ),
    p.pending && (0, import_react.createElement)(
      "div",
      { style: c.banner("error"), "data-testid": "lp-conflict" },
      (0, import_react.createElement)("div", null, (0, import_react.createElement)("strong", null, "Update stopped on conflicts. "), "Your live plugin is unchanged."),
      (0, import_react.createElement)("div", { style: { ...c.mono, margin: "6px 0" } }, p.pending.conflicts.map((f) => (0, import_react.createElement)("div", { key: f }, `\u2022 ${f}`))),
      (0, import_react.createElement)("div", { style: c.muted }, `Resolve in ${tilde(p.pending.worktree, homePath)}`),
      (0, import_react.createElement)(
        "div",
        { style: { ...c.row, marginTop: 8 } },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => run("finish", { name: p.name }) }, "Finish update"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => agent("conflict") }, "Fix with agent"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "confirm", title: `Abort the update of ${p.name}?`, body: "The merge attempt is thrown away. Your local branch and the live plugin stay as they are.", action: () => run("abort", { name: p.name }) }) }, "Abort")
      )
    ),
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, marginTop: 10 } },
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy || Boolean(p.pending), onClick: () => run("apply", { name: p.name }) }, p.applied ? "Apply latest commit" : "Apply"),
      p.update?.available && !p.pending && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => run("update", { name: p.name }) }, "Update"),
      p.applied && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => openModal({ kind: "confirm", title: `Restore the original ${p.name}?`, body: p.kind === "core" ? "dsh goes back to the built-in package that shipped with it. Your local repo stays tracked \u2014 click Apply to switch back." : "dsh installs the original's latest release. Your local repo stays tracked \u2014 click Apply to switch back.", action: () => run("restore", { name: p.name }) }) }, "Restore original"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "commit", plugin: p }) }, "Commit"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "rollback", plugin: p }) }, "Deploy older commit\u2026"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "deps", plugin: p }) }, "Dependency overrides"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", onClick: () => agent("work") }, "Work on it")
    ),
    agentErr && (0, import_react.createElement)("div", { style: { ...c.muted, color: "var(--dsw-alias-state-error-primary,#dc2626)", marginTop: 6 } }, `Could not open agent session: ${agentErr}`)
  );
}
function AddModal({ onClose, run }) {
  const [tab, setTab] = (0, import_react.useState)("migrate");
  const [installed, setInstalled] = (0, import_react.useState)(null);
  const [filter, setFilter] = (0, import_react.useState)("");
  const [picked, setPicked] = (0, import_react.useState)(null);
  const [origin, setOrigin] = (0, import_react.useState)("auto");
  const [input, setInput] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    call("installed").then(setInstalled, (e) => setInstalled({ error: e.message }));
  }, []);
  const items = (0, import_react.useMemo)(() => {
    if (!installed || installed.error) return [];
    const all = [
      ...installed.profile.map((x) => ({ name: x.name, kind: "third-party", detail: x.version ?? x.spec })),
      ...installed.core.map((n) => ({ name: n, kind: "core", detail: "built-in" }))
    ];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((x) => x.name.toLowerCase().includes(f)) : all;
  }, [installed, filter]);
  const footer = tab === "migrate" ? (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !picked, onClick: () => {
    run("migrate", { name: picked.name, origin });
    onClose();
  } }, "Migrate to local") : (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !input.trim(), onClick: () => {
    run("add", { input });
    onClose();
  } }, "Add locally");
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    { open: true, onClose, title: "Add a local plugin", closeLabel: "Close", footer },
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, marginBottom: 10 } },
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: tab === "migrate" ? "primary" : "outline", onClick: () => setTab("migrate") }, "Migrate installed"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: tab === "new" ? "primary" : "outline", onClick: () => setTab("new") }, "New from origin")
    ),
    tab === "migrate" ? (0, import_react.createElement)(
      "div",
      null,
      (0, import_react.createElement)("div", { style: c.muted }, "Copies an installed plugin into its own git repo. Nothing changes in dsh until you click Apply."),
      (0, import_react.createElement)("input", { style: { ...c.input, width: "100%", marginTop: 8 }, placeholder: "Filter\u2026", value: filter, onChange: (e) => setFilter(e.target.value), "data-testid": "lp-add-filter" }),
      installed?.error ? (0, import_react.createElement)("div", { style: c.banner("error") }, installed.error) : null,
      (0, import_react.createElement)("div", { style: c.list }, !installed ? (0, import_react.createElement)("div", { style: { ...c.muted, padding: 10 } }, "Loading\u2026") : items.map((x) => (0, import_react.createElement)(
        "div",
        { key: x.name, style: c.listItem(picked?.name === x.name), onClick: () => setPicked(x), "data-testid": `lp-pick-${x.name}` },
        (0, import_react.createElement)("span", null, x.name),
        (0, import_react.createElement)("span", { style: c.muted }, `${x.kind} \xB7 ${x.detail}`)
      ))),
      picked?.kind === "third-party" && (0, import_react.createElement)(
        "div",
        { style: { ...c.row, marginTop: 10, fontSize: 13 } },
        "Origin:",
        ["auto", "git", "npm"].map((o) => (0, import_react.createElement)(
          "label",
          { key: o, style: { display: "inline-flex", gap: 4, alignItems: "center" } },
          (0, import_react.createElement)("input", { type: "radio", name: "lp-origin", checked: origin === o, onChange: () => setOrigin(o) }),
          o === "auto" ? "auto (git if reachable)" : o
        ))
      )
    ) : (0, import_react.createElement)(
      "div",
      null,
      (0, import_react.createElement)("div", { style: c.muted }, "An npm package name (e.g. dsh-foo, @scope/pkg) or a git URL (https://github.com/user/repo). It is set up locally but not applied."),
      (0, import_react.createElement)("input", { style: { ...c.input, width: "100%", marginTop: 8 }, placeholder: "npm name or git URL", value: input, onChange: (e) => setInput(e.target.value), "data-testid": "lp-add-input" })
    )
  );
}
function CommitModal({ plugin, onClose, run }) {
  const [msg, setMsg] = (0, import_react.useState)("");
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: `Commit ${plugin.name}`,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: () => {
        run("commit", { name: plugin.name, message: msg });
        onClose();
      } }, "Commit")
    },
    (0, import_react.createElement)("div", { style: c.muted }, `${plugin.stats?.uncommitted ?? 0} uncommitted file(s). Committing does not deploy \u2014 click Apply for that.`),
    (0, import_react.createElement)("input", { style: { ...c.input, width: "100%", marginTop: 8 }, placeholder: "Message (optional)", value: msg, onChange: (e) => setMsg(e.target.value) })
  );
}
function RollbackModal({ plugin, onClose, run }) {
  const [commits, setCommits] = (0, import_react.useState)(null);
  const [picked, setPicked] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    call("commits", { name: plugin.name }).then((r) => setCommits(r.commits), (e) => setCommits({ error: e.message }));
  }, [plugin.name]);
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: `Deploy a commit of ${plugin.name}`,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !picked, onClick: () => {
        run("apply", { name: plugin.name, ref: picked });
        onClose();
      } }, "Deploy this commit")
    },
    (0, import_react.createElement)("div", { style: c.muted }, "dsh runs exactly the commit you pick (restart to load it)."),
    (0, import_react.createElement)("div", { style: c.list }, !commits ? (0, import_react.createElement)("div", { style: { ...c.muted, padding: 10 } }, "Loading\u2026") : commits.error ? (0, import_react.createElement)("div", { style: { padding: 10 } }, commits.error) : commits.map((x) => (0, import_react.createElement)(
      "div",
      { key: x.sha, style: c.listItem(picked === x.sha), onClick: () => setPicked(x.sha) },
      (0, import_react.createElement)("span", null, (0, import_react.createElement)("span", { style: c.mono }, short(x.sha)), " ", x.subject, x.sha === plugin.deployedSha ? " (running)" : ""),
      (0, import_react.createElement)("span", { style: c.muted }, new Date(x.date).toLocaleString())
    )))
  );
}
function DepsModal({ plugin, onClose, run }) {
  const [dep, setDep] = (0, import_react.useState)("");
  const [range, setRange] = (0, import_react.useState)("latest");
  const entries = Object.entries(plugin.depOverrides ?? {});
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: `Dependency overrides \u2014 ${plugin.name}`,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !dep.trim(), onClick: () => {
        run("setDep", { name: plugin.name, dep: dep.trim(), range: range.trim() || "latest" });
        onClose();
      } }, "Save override")
    },
    (0, import_react.createElement)("div", { style: c.muted }, "Changes the dependency range in the plugin's package.json as a commit. It takes effect on Apply" + (plugin.kind === "core" ? " (the dependency is installed into the dsh install)." : " (installed into the snapshot).")),
    entries.length ? (0, import_react.createElement)("div", { style: { marginTop: 8 } }, entries.map(([d, r]) => (0, import_react.createElement)(
      "div",
      { key: d, style: { ...c.row, fontSize: 13 } },
      (0, import_react.createElement)("span", { style: c.mono }, `${d} \u2192 ${r}`),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", onClick: () => {
        run("setDep", { name: plugin.name, dep: d, range: null });
        onClose();
      } }, "Remove")
    ))) : null,
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, marginTop: 10 } },
      (0, import_react.createElement)("input", { style: { ...c.input, flex: 2 }, placeholder: "dependency, e.g. @earendil-works/pi-ai", value: dep, onChange: (e) => setDep(e.target.value) }),
      (0, import_react.createElement)("input", { style: { ...c.input, flex: 1 }, placeholder: "range", value: range, onChange: (e) => setRange(e.target.value) })
    )
  );
}
function ConfirmModal({ title, body, action, onClose }) {
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(
        "div",
        { style: c.row },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose }, "Cancel"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: () => {
          action();
          onClose();
        } }, "Continue")
      )
    },
    (0, import_react.createElement)("div", { style: { fontSize: 13, lineHeight: 1.6 } }, body)
  );
}
function LocalPluginsSection({ store, ctx, close }) {
  const { snapshot: s, error } = useStore(store);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [modal, setModal] = (0, import_react.useState)(null);
  const [restarting, setRestarting] = (0, import_react.useState)(false);
  const run = useAction(store, setNotice);
  const busy = Boolean(s?.op);
  async function restart() {
    setRestarting(true);
    try {
      const before = s.bootId;
      await call("restart");
      const started = Date.now();
      const poll = async () => {
        try {
          const next = await call("state", {}, { timeoutMs: 3e3 });
          if (next.bootId && next.bootId !== before) {
            location.reload();
            return;
          }
        } catch {
        }
        if (Date.now() - started > 12e4) {
          setRestarting(false);
          setNotice({ tone: "error", text: "dsh web did not come back within 2 minutes \u2014 check the restart log in $DSH_HOME/logs." });
          return;
        }
        setTimeout(poll, 1e3);
      };
      setTimeout(poll, 1e3);
    } catch (err) {
      setRestarting(false);
      setNotice({ tone: "error", text: err.message });
    }
  }
  const homePath = s?.env?.home ?? "";
  if (!s) return (0, import_react.createElement)("div", { style: c.muted }, error ? `Could not load: ${error}` : "Loading\u2026");
  const modalEl = !modal ? null : modal.kind === "add" ? (0, import_react.createElement)(AddModal, { onClose: () => setModal(null), run }) : modal.kind === "commit" ? (0, import_react.createElement)(CommitModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "rollback" ? (0, import_react.createElement)(RollbackModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "deps" ? (0, import_react.createElement)(DepsModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : (0, import_react.createElement)(ConfirmModal, { ...modal, onClose: () => setModal(null) });
  return (0, import_react.createElement)(
    "div",
    { "data-testid": "lp-section", style: { maxWidth: 720 } },
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, justifyContent: "space-between" } },
      (0, import_react.createElement)(
        "div",
        null,
        (0, import_react.createElement)("div", { style: { fontSize: 16, fontWeight: 500 } }, "Local Plugins"),
        (0, import_react.createElement)("div", { style: c.muted }, `Edited plugins kept as git repos in ${tilde(s.env.root, homePath)}. dsh only runs committed code \u2014 Apply deploys a commit.`)
      ),
      (0, import_react.createElement)(
        "div",
        { style: c.row },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => run("check", {}) }, "Check now"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => setModal({ kind: "add" }) }, "+ Add")
      )
    ),
    s.upgrade && (0, import_react.createElement)(
      "div",
      { style: c.banner("warn"), "data-testid": "lp-upgrade" },
      (0, import_react.createElement)("strong", null, s.upgrade.from && s.upgrade.to && s.upgrade.from !== s.upgrade.to ? `dsh upgraded ${s.upgrade.from} \u2192 ${s.upgrade.to}. ` : "dsh was reinstalled. "),
      `${s.upgrade.lost} applied plugin link(s) were reset to the original. Reapply all checks every origin for updates first, then re-links.`,
      (0, import_react.createElement)("div", { style: { marginTop: 8 } }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => run("reapplyAll", {}) }, "Reapply all"))
    ),
    s.restartNeeded && (0, import_react.createElement)(
      "div",
      { style: c.banner("info"), "data-testid": "lp-restart" },
      (0, import_react.createElement)("strong", null, "Restart needed. "),
      "Changes load when dsh web restarts (open chats reconnect).",
      (0, import_react.createElement)("div", { style: { marginTop: 8 } }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy || restarting, onClick: restart }, restarting ? "Restarting\u2026" : "Restart dsh web"))
    ),
    notice && (0, import_react.createElement)(
      "div",
      { style: c.banner(notice.tone === "error" ? "error" : "info") },
      notice.text,
      " ",
      (0, import_react.createElement)("button", { style: { border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "inherit" }, onClick: () => setNotice(null) }, "\u2715")
    ),
    (0, import_react.createElement)(OpPanel, { op: s.op, lastOp: s.lastOp }),
    s.plugins.length === 0 ? (0, import_react.createElement)("div", { style: { ...c.card, ...c.muted } }, 'No local plugins yet. Use "+ Add" to migrate an installed plugin or set one up from its origin.') : s.plugins.map((p) => (0, import_react.createElement)(PluginCard, { key: p.name, p, run, busy, ctx, close, openModal: setModal, homePath })),
    modalEl
  );
}
function SidebarBadge({ store, wide }) {
  const { snapshot } = useStore(store);
  const n = attentionCount(snapshot);
  if (!n) return null;
  const open = () => {
    const pickSection = (tries = 0) => {
      const cell = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === SECTION_LABEL);
      if (cell) cell.click();
      else if (tries < 40) setTimeout(() => pickSection(tries + 1), 50);
    };
    const trigger = document.querySelector('button[aria-label="Settings"][aria-haspopup="dialog"]');
    if (trigger && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    setTimeout(pickSection, 50);
  };
  return (0, import_react.createElement)("button", {
    "data-testid": "lp-badge",
    title: `${n} local plugin item(s) need attention`,
    onClick: open,
    style: { display: "flex", alignItems: "center", gap: 6, width: wide ? "100%" : 36, height: 32, border: "none", background: "none", cursor: "pointer", padding: wide ? "0 8px" : 0, justifyContent: wide ? "flex-start" : "center", color: "var(--dsw-alias-label-primary,inherit)", fontSize: 13, borderRadius: 8 }
  }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "warning" }, String(n)), wide ? "Local plugins" : null);
}
function apply(ctx) {
  const store = createStateStore();
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: SECTION_ID,
      order: 45,
      label: () => SECTION_LABEL,
      inject: () => ({ store, ctx })
    },
    LocalPluginsSection
  ));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    {
      name: "sidebar.footer.action",
      id: "local-plugins-badge",
      order: 60,
      inject: () => ({ store, ctx })
    },
    SidebarBadge
  ));
}

    return module.exports;
  }
});
