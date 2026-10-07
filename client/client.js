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
var AGENT_PRESET = "cordis";
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
  if (!data.ok) {
    const e = data.error ?? {};
    throw Object.assign(new Error(typeof e === "string" ? e : e.message ?? `${action} failed`), { code: e.code, details: e.details });
  }
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
  for (const p of s.plugins) if (p.pending || p.update?.available || p.disabled || p.status?.id === "BROKEN") n++;
  n += (s.notices ?? []).length;
  if (s.registryError) n++;
  return n;
}
async function openAgentSession(ctx, { path, text }) {
  const workspaces = ctx.get("workspaces");
  const sessions = ctx.get("sessions");
  const ws = await workspaces.create({ path });
  const sid = await sessions.create({ workspaceId: ws.workspaceId });
  for (const preset of [AGENT_PRESET, "standard"]) {
    try {
      const r = await ctx.remote.agentPresets.select(sid, preset);
      if (!r || r.ok !== false) break;
      console.warn(`[dsh-local-plugins] preset "${preset}" refused`, r.error);
    } catch (err) {
      console.warn(`[dsh-local-plugins] preset "${preset}" failed`, err);
    }
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
var STATUS_TONE = { APPLIED: "success", CHANGES_PENDING: "warning", UPDATE_AVAILABLE: "warning", CONFLICT: "danger", LINK_LOST: "warning", REAPPLY_REQUIRED: "warning", BROKEN: "danger", DISABLED: "danger", TRACKED: "neutral" };
var CRASH_KINDS = ["crash-revert", "crash-recovery", "crash-revert-failed", "registry-rebuilt"];
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
var EXPECTED_API = 2;
var fmtBytes = (n) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round((n || 0) / 1024))} KB`;
var fmtDur = (ms) => ms < 1e3 ? `${Math.round(ms)} ms` : `${(ms / 1e3).toFixed(1)} s`;
var VERB = { apply: "Applying", update: "Updating", "finish update": "Finishing the update of", "abort update": "Aborting the update of", "restore original": "Unlinking", commit: "Committing", "dependency override": "Saving a dependency override for", migrate: "Migrating", add: "Adding", check: "Checking for updates", "reapply all": "Reapplying", repair: "Repairing the installation", delete: "Deleting", cleanup: "Cleaning up", trust: "Changing script permission for", "startup recovery": "Checking the installation" };
var linkButton = { border: "none", background: "none", cursor: "pointer", color: "inherit", textDecoration: "underline", padding: 0, fontSize: 12 };
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
function OpPanel({ op, lastOp, run, workOn, plugins }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [dismissed, setDismissed] = (0, import_react.useState)(null);
  const [copied, setCopied] = (0, import_react.useState)(false);
  const [, tick] = (0, import_react.useState)(0);
  const ref = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (!op) return void 0;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [op?.id]);
  (0, import_react.useEffect)(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  const shown = op ?? lastOp;
  if (!shown || !op && dismissed === shown.id) return null;
  const running = shown.status === "running";
  const failed = shown.status === "error";
  const label = `${shown.kind}${shown.target ? ` ${shown.target}` : ""}`;
  const elapsed = running ? Date.now() - shown.startedAt : shown.durationMs ?? 0;
  const lastLine = shown.log.length ? shown.log[shown.log.length - 1] : "";
  const plugin = plugins.find((p) => p.name === shown.target);
  const exists = Boolean(plugin);
  const pathToCopy = plugin?.pending?.worktree ?? plugin?.repo ?? null;
  const pathLabel = plugin?.pending ? "Copy worktree path" : "Copy repo path";
  const canRetry = failed && shown.request && !shown.needsTrust && shown.errorCode !== "BUSY";
  const logBox = (open || running) && (0, import_react.createElement)("pre", { ref, style: c.pre }, shown.log.slice(-200).join("\n"));
  const logButtons = [
    (0, import_react.createElement)("button", { key: "v", style: linkButton, onClick: () => setOpen(!open) }, open ? "Hide logs" : "View logs"),
    (0, import_react.createElement)("button", { key: "c", style: linkButton, onClick: async () => {
      setCopied(await copyText(shown.log.join("\n")));
      setTimeout(() => setCopied(false), 1500);
    } }, copied ? "Copied" : "Copy log")
  ];
  if (running) {
    return (0, import_react.createElement)(
      "div",
      { style: c.banner("info"), "data-testid": "lp-op" },
      (0, import_react.createElement)("div", { style: c.row }, (0, import_react.createElement)("strong", null, `\u23F3 ${VERB[shown.kind] ?? shown.kind}${shown.target ? ` ${shown.target}` : ""}\u2026`), (0, import_react.createElement)("span", { style: c.muted }, fmtDur(elapsed))),
      lastLine && (0, import_react.createElement)("div", { style: { ...c.muted, marginTop: 4 } }, lastLine.slice(0, 160)),
      logBox
    );
  }
  if (!failed) {
    return (0, import_react.createElement)(
      "div",
      { style: { ...c.muted, marginTop: 10 }, "data-testid": "lp-op" },
      `\u2714 ${label} \u2014 done in ${fmtDur(elapsed)} \xB7 `,
      logButtons[0],
      " \xB7 ",
      logButtons[1],
      " \xB7 ",
      (0, import_react.createElement)("button", { style: linkButton, onClick: () => setDismissed(shown.id) }, "dismiss"),
      logBox
    );
  }
  return (0, import_react.createElement)(
    "div",
    { style: c.banner("error"), "data-testid": "lp-op" },
    (0, import_react.createElement)("div", { style: c.row }, (0, import_react.createElement)("strong", null, `\u2716 ${shown.title ?? "Failed"}`), shown.target && (0, import_react.createElement)("span", { style: c.muted }, shown.target), (0, import_react.createElement)("button", { style: { ...linkButton, marginLeft: "auto" }, onClick: () => setDismissed(shown.id) }, "dismiss")),
    (0, import_react.createElement)("div", { style: { marginTop: 6, whiteSpace: "pre-wrap" } }, shown.error),
    shown.advice && (0, import_react.createElement)(
      "div",
      { style: { marginTop: 8 } },
      (0, import_react.createElement)("div", null, (0, import_react.createElement)("strong", null, "Is it safe? "), shown.advice.safe),
      (0, import_react.createElement)("div", { style: { marginTop: 4 } }, (0, import_react.createElement)("strong", null, "What now? "), shown.advice.next)
    ),
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, marginTop: 8 } },
      canRetry && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", onClick: () => run(shown.request.action, shown.request.body) }, "Retry"),
      exists && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", onClick: () => workOn(shown.target, shown.request?.action === "finish" ? "conflict" : "work") }, "Work on it"),
      logButtons[0],
      logButtons[1],
      pathToCopy && (0, import_react.createElement)("button", { style: linkButton, onClick: async () => {
        setCopied(await copyText(pathToCopy));
        setTimeout(() => setCopied(false), 1500);
      }, title: pathToCopy, "data-testid": "lp-copy-path" }, pathLabel),
      (0, import_react.createElement)("span", { style: c.muted }, `${fmtDur(elapsed)}${shown.errorCode ? ` \xB7 ${shown.errorCode}` : ""}`)
    ),
    logBox
  );
}
function HistoryPanel({ s }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [rows, setRows] = (0, import_react.useState)([]);
  const [sel, setSel] = (0, import_react.useState)(null);
  const [full, setFull] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    call("history").then((v) => setRows(v.operations)).catch(() => {
    });
  }, [open, s.lastOp?.id, s.op?.id]);
  (0, import_react.useEffect)(() => {
    if (sel == null) {
      setFull(null);
      return;
    }
    call("op", { id: sel }).then(setFull).catch(() => setFull(null));
  }, [sel]);
  return (0, import_react.createElement)(
    "div",
    { style: { marginTop: 10 } },
    (0, import_react.createElement)("button", { style: linkButton, onClick: () => setOpen(!open), "data-testid": "lp-history-toggle" }, open ? "Hide recent operations" : "Recent operations"),
    open && (0, import_react.createElement)(
      "div",
      { style: { ...c.list, maxHeight: 200 }, "data-testid": "lp-history" },
      rows.length === 0 ? (0, import_react.createElement)("div", { style: { ...c.muted, padding: 10 } }, "Nothing has run since dsh started.") : rows.map((o) => (0, import_react.createElement)(
        "div",
        { key: o.id, style: c.listItem(sel === o.id), onClick: () => setSel(sel === o.id ? null : o.id) },
        (0, import_react.createElement)("span", null, `${o.status === "ok" ? "\u2714" : o.status === "error" ? "\u2716" : "\u23F3"} ${o.kind}${o.target ? ` ${o.target}` : ""}`),
        (0, import_react.createElement)("span", { style: c.muted }, `${fmtDur(o.durationMs ?? 0)}${o.status === "error" && o.errorCode ? ` \xB7 ${o.errorCode}` : ""}`)
      ))
    ),
    open && full && (0, import_react.createElement)("pre", { style: c.pre }, `${full.error ? `${full.error}

` : ""}${full.log.join("\n")}`)
  );
}
function DiskPanel({ busy, run, openModal, settings }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [keep, setKeep] = (0, import_react.useState)(null);
  const [saved, setSaved] = (0, import_react.useState)(null);
  const [data, setData] = (0, import_react.useState)(null);
  const [err, setErr] = (0, import_react.useState)(null);
  async function load() {
    setErr(null);
    try {
      setData(await call("diskUsage", {}, { timeoutMs: 6e4 }));
    } catch (e) {
      setErr(e.message);
    }
  }
  (0, import_react.useEffect)(() => {
    if (open) load();
  }, [open]);
  return (0, import_react.createElement)(
    "div",
    { style: { marginTop: 10 } },
    (0, import_react.createElement)("button", { style: linkButton, onClick: () => setOpen(!open), "data-testid": "lp-disk-toggle" }, open ? "Hide disk usage" : "Disk usage"),
    open && (0, import_react.createElement)(
      "div",
      { style: c.card, "data-testid": "lp-disk" },
      err && (0, import_react.createElement)("div", { style: { color: "var(--dsw-alias-state-error-primary,#dc2626)" } }, `Could not measure disk usage: ${err}`),
      !data && !err && (0, import_react.createElement)("div", { style: c.muted }, "Measuring\u2026"),
      data && (0, import_react.createElement)(
        "div",
        null,
        Object.entries(data.plugins).map(([name2, u]) => (0, import_react.createElement)(
          "div",
          { key: name2, style: { ...c.row, justifyContent: "space-between", fontSize: 13 } },
          (0, import_react.createElement)("span", null, name2),
          (0, import_react.createElement)("span", { style: c.muted }, `repo ${fmtBytes(u.repo)} \xB7 ${u.snapshotCount} snapshot(s) ${fmtBytes(u.snapshots)} \xB7 worktrees ${fmtBytes(u.worktrees)} \xB7 backups ${fmtBytes(u.backups)}`)
        )),
        (0, import_react.createElement)(
          "div",
          { style: { ...c.row, justifyContent: "space-between", marginTop: 8, fontSize: 13 } },
          (0, import_react.createElement)("strong", null, `Total ${fmtBytes(data.total)}`),
          (0, import_react.createElement)("span", { style: c.muted }, `trash ${fmtBytes(data.trash)}`)
        ),
        settings && (0, import_react.createElement)(
          "div",
          { style: { ...c.row, marginTop: 10, fontSize: 13 }, "data-testid": "lp-retention" },
          (0, import_react.createElement)("span", null, "Keep"),
          (0, import_react.createElement)("input", { type: "number", min: 1, max: 20, style: { ...c.input, width: 64 }, disabled: settings.keepFromEnv, value: keep ?? settings.keepSnapshots, onChange: (e) => {
            setKeep(e.target.value);
            setSaved(null);
          }, "data-testid": "lp-keep-input" }),
          (0, import_react.createElement)("span", null, "deployments per plugin"),
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: settings.keepFromEnv || keep == null || Number(keep) === settings.keepSnapshots, onClick: async () => {
            try {
              await call("setSettings", { keepSnapshots: Number(keep) });
              setSaved("Saved");
            } catch (e) {
              setSaved(e.message);
            }
          } }, "Save"),
          saved && (0, import_react.createElement)("span", { style: c.muted }, saved),
          (0, import_react.createElement)("div", { style: { ...c.muted, width: "100%" } }, settings.keepFromEnv ? "Set by the LPM_KEEP_SNAPSHOTS environment variable, which overrides this." : "The live deployment and the one you can roll back to are always kept, whatever this says.")
        ),
        (0, import_react.createElement)(
          "div",
          { style: { ...c.row, marginTop: 8 } },
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => openModal({ kind: "cleanup" }) }, "Clean up old snapshots\u2026"),
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", onClick: load }, "Measure again")
        )
      )
    )
  );
}
function CleanupModal({ run, onClose }) {
  const [plan, setPlan] = (0, import_react.useState)(null);
  const [err, setErr] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    call("cleanupPreview", {}, { timeoutMs: 6e4 }).then(setPlan).catch((e) => setErr(e.message));
  }, []);
  const nothing = plan && plan.snapshots.length === 0;
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: "Clean up old snapshots",
      closeLabel: "Close",
      footer: (0, import_react.createElement)(
        "div",
        { style: c.row },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose }, "Cancel"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: !plan || nothing, onClick: () => {
          run("cleanup", { execute: true });
          onClose();
        } }, plan && !nothing ? `Remove ${plan.snapshots.length} (${fmtBytes(plan.bytes)})` : "Remove")
      )
    },
    (0, import_react.createElement)(
      "div",
      { style: { fontSize: 13, lineHeight: 1.6 } },
      err ? `Could not prepare the preview: ${err}` : !plan ? "Working out what can be removed\u2026" : nothing ? "Nothing to clean up: every snapshot is either live, the rollback target, or within the retention limit." : (0, import_react.createElement)(
        "div",
        null,
        "These deployments are older than the retention limit. The live one and the rollback target are never removed, and any of them can be rebuilt from git:",
        (0, import_react.createElement)("ul", { style: { margin: "8px 0 0 18px", padding: 0 } }, plan.snapshots.map((x) => (0, import_react.createElement)("li", { key: `${x.kind ?? "snapshot"}-${x.name}`, style: c.mono }, `${x.kind === "worktree" ? "(leftover trial merge) " : ""}${x.name} \u2014 ${fmtBytes(x.bytes)}`)))
      )
    )
  );
}
function DeleteModal({ plugin, run, onClose }) {
  const [typed, setTyped] = (0, import_react.useState)("");
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: `Delete local plugin ${plugin.name}?`,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(
        "div",
        { style: c.row },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose }, "Cancel"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: typed !== plugin.name, onClick: () => {
          run("delete", { name: plugin.name, confirmName: typed });
          onClose();
        } }, "Delete")
      )
    },
    (0, import_react.createElement)(
      "div",
      { style: { fontSize: 13, lineHeight: 1.6 } },
      (0, import_react.createElement)("p", { style: { marginTop: 0 } }, "This stops tracking the plugin. dsh is not affected (it already has the original back)."),
      (0, import_react.createElement)("p", null, "Your repo, with every commit and stash, is ", (0, import_react.createElement)("strong", null, "moved to the trash folder"), " (not deleted) and can be moved back; deployment snapshots are removed because they can be rebuilt."),
      (0, import_react.createElement)("p", null, `Type ${plugin.name} to confirm:`),
      (0, import_react.createElement)("input", { style: { ...c.input, width: "100%" }, value: typed, placeholder: plugin.name, onChange: (e) => setTyped(e.target.value), "data-testid": "lp-delete-input" })
    )
  );
}
function PluginCard({ p, run, busy, ctx, close, openModal, homePath, lastOp, issues }) {
  const stats = p.stats ?? {};
  const state = p.applied ? p.linkLost ? "Link lost" : "Applied" : "Tracked only";
  const tone = p.applied ? p.linkLost ? "warning" : "success" : "neutral";
  const st = p.status;
  const allows = (a) => !st || st.allowed.includes(a);
  const fixedSinceCrash = !p.disabled || stats.head && stats.head !== p.lastCrash?.localHead || stats.uncommitted > 0;
  const myIssues = (issues ?? []).filter((i) => i.plugin === p.name && i.severity !== "info");
  const [agentErr, setAgentErr] = (0, import_react.useState)(null);
  const trustAsk = lastOp && lastOp.status === "error" && lastOp.needsTrust && lastOp.request && lastOp.target === p.name ? lastOp : null;
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
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: st ? STATUS_TONE[st.id] ?? tone : tone }, st ? `${st.label}${st.id === "UPDATE_AVAILABLE" && p.update?.target && p.update.target !== "upstream" ? ` ${short(p.update.target)}` : ""}` : state),
      p.trustScripts && (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "warning" }, "Scripts always allowed")
    ),
    (0, import_react.createElement)("div", { style: { ...c.muted, marginTop: 4 } }, (0, import_react.createElement)("button", { style: { ...linkButton, float: "right" }, onClick: () => copyText(p.pending?.worktree ?? p.repo), title: p.pending?.worktree ?? p.repo, "data-testid": `lp-path-${p.name}` }, p.pending ? "Copy worktree path" : "Copy repo path"), p.source.type === "git" ? `git \xB7 ${tilde(p.source.url, homePath)}` : `npm \xB7 ${p.source.name}`),
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
    p.disabled && (0, import_react.createElement)(
      "div",
      { style: c.banner("error"), "data-testid": "lp-disabled" },
      (0, import_react.createElement)("strong", null, "Disabled \u2014 it crashed dsh. "),
      'It was taken out of dsh so dsh can start. Your repo and commits are untouched. Use "Work on it" to fix it with an agent, commit the fix, then Apply becomes available.'
    ),
    myIssues.length > 0 && (0, import_react.createElement)(
      "div",
      { style: c.banner(myIssues.some((i) => i.severity === "error") ? "error" : "warn"), "data-testid": "lp-issues" },
      (0, import_react.createElement)("div", null, myIssues.map((i) => (0, import_react.createElement)("div", { key: i.code }, `\u2022 ${i.message}`))),
      (0, import_react.createElement)("div", { style: { marginTop: 6 } }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => run("repair", {}) }, "Repair installation"))
    ),
    trustAsk && (0, import_react.createElement)(
      "div",
      { style: c.banner("error"), "data-testid": "lp-trust" },
      (0, import_react.createElement)("div", null, (0, import_react.createElement)("strong", null, "Permission needed. "), `${p.name} wants to run scripts on your computer, with your full access:`),
      (0, import_react.createElement)("ul", { style: { margin: "6px 0 6px 18px", padding: 0, fontSize: 12 } }, trustAsk.needsTrust.map((r) => (0, import_react.createElement)("li", { key: r }, r))),
      (0, import_react.createElement)("div", { style: c.muted }, "Only continue if you trust this plugin and its publisher. Nothing has gone live yet."),
      (0, import_react.createElement)(
        "div",
        { style: { ...c.row, marginTop: 8 } },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => run(trustAsk.request.action, { ...trustAsk.request.body, allowScripts: true }) }, "Allow this time"),
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => run(trustAsk.request.action, { ...trustAsk.request.body, alwaysAllow: true }) }, "Always allow for this plugin")
      )
    ),
    (0, import_react.createElement)(
      "div",
      { style: { ...c.row, marginTop: 10 } },
      allows("apply") && fixedSinceCrash && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: st?.primary === "apply" || !st ? "primary" : "outline", disabled: busy || Boolean(p.pending), onClick: () => p.kind === "core" && !p.applied ? openModal({ kind: "confirm", title: `Replace the built-in ${p.name}?`, body: 'This changes a package inside your dsh installation: the original folder is moved to a backup and replaced by a link to your version. "Unlink" puts the original back, and if dsh crashes after this the original is restored automatically. Continue?', action: () => run("apply", { name: p.name }) }) : run("apply", { name: p.name }) }, p.applied ? "Apply latest commit" : "Apply"),
      p.update?.available && allows("update") && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: st?.primary === "update" ? "primary" : "outline", disabled: busy, onClick: () => run("update", { name: p.name }) }, "Update"),
      p.applied && allows("restore") && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", disabled: busy, onClick: () => openModal({ kind: "confirm", title: `Unlink ${p.name} and restore the original?`, body: p.kind === "core" ? "dsh goes back to the built-in package that shipped with it. Your local repo stays tracked \u2014 click Apply to switch back." : "dsh reinstalls the original version spec it had before (for example ^1.0.0). Your local repo stays tracked \u2014 click Apply to switch back.", action: () => run("restore", { name: p.name }) }) }, "Unlink (restore original)"),
      allows("delete") && !p.applied && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "delete", plugin: p }), "data-testid": `lp-delete-${p.name}` }, "Delete\u2026"),
      allows("commit") && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "commit", plugin: p }) }, "Commit"),
      allows("rollback") && !p.disabled && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: st?.primary === "rollback" ? "outline" : "ghost", disabled: busy, onClick: () => openModal({ kind: "rollback", plugin: p }) }, "Deploy older commit\u2026"),
      allows("setDep") && !p.disabled && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => openModal({ kind: "deps", plugin: p }) }, "Dependency overrides"),
      p.trustScripts && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => run("trust", { name: p.name, trust: false }) }, "Revoke script permission"),
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: p.disabled ? "primary" : "ghost", onClick: () => agent(p.disabled ? "crash" : "work") }, "Work on it")
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
  async function workOn(name2, mode = "work") {
    try {
      const draft = await call("agentDraft", { name: name2, mode });
      close?.();
      await openAgentSession(ctx, draft);
    } catch (err) {
      setNotice({ tone: "error", text: `Could not open an agent session: ${err.message}` });
    }
  }
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
  const modalEl = !modal ? null : modal.kind === "add" ? (0, import_react.createElement)(AddModal, { onClose: () => setModal(null), run }) : modal.kind === "commit" ? (0, import_react.createElement)(CommitModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "rollback" ? (0, import_react.createElement)(RollbackModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "deps" ? (0, import_react.createElement)(DepsModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "delete" ? (0, import_react.createElement)(DeleteModal, { plugin: modal.plugin, onClose: () => setModal(null), run }) : modal.kind === "cleanup" ? (0, import_react.createElement)(CleanupModal, { onClose: () => setModal(null), run }) : (0, import_react.createElement)(ConfirmModal, { ...modal, onClose: () => setModal(null) });
  return (0, import_react.createElement)(
    "div",
    { "data-testid": "lp-section", style: { maxWidth: 720 } },
    s.apiVersion !== EXPECTED_API && (0, import_react.createElement)(
      "div",
      { style: c.banner("error"), "data-testid": "lp-version" },
      (0, import_react.createElement)("strong", null, "This page is out of date. "),
      `It speaks API ${EXPECTED_API} but the server speaks ${s.apiVersion ?? "an older version"}. Reload the page.`,
      (0, import_react.createElement)("div", { style: { marginTop: 8 } }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", onClick: () => location.reload() }, "Reload"))
    ),
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
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "ghost", disabled: busy, onClick: () => run("repair", {}), title: "Finish or roll back interrupted operations and make the registry match what is on disk" }, "Repair installation"),
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
    s.registryError && (0, import_react.createElement)(
      "div",
      { style: c.banner("error"), "data-testid": "lp-registry-error" },
      (0, import_react.createElement)("strong", null, "The plugin registry cannot be read. "),
      s.registryError.message,
      s.registryError.code !== "REGISTRY_TOO_NEW" && (0, import_react.createElement)("div", { style: { marginTop: 8 } }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => run("repair", {}) }, "Repair installation"))
    ),
    (s.notices ?? []).map((n) => (0, import_react.createElement)(
      "div",
      { key: n.id, style: c.banner(n.kind === "info" ? "info" : n.kind === "crash-recovery" ? "warn" : "error"), "data-testid": "lp-notice" },
      (0, import_react.createElement)("div", null, (0, import_react.createElement)("strong", null, n.title)),
      (0, import_react.createElement)("div", { style: { marginTop: 4, fontSize: 12, lineHeight: 1.5 } }, n.message),
      (0, import_react.createElement)(
        "div",
        { style: { ...c.row, marginTop: 6 } },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { size: "sm", variant: "outline", onClick: async () => {
          await call("dismissNotice", { id: n.id }).catch(() => {
          });
          store.refresh();
        } }, "Dismiss")
      )
    )),
    (0, import_react.createElement)(OpPanel, { op: s.op, lastOp: s.lastOp, run, workOn, plugins: s.plugins }),
    (0, import_react.createElement)(HistoryPanel, { s }),
    (0, import_react.createElement)(DiskPanel, { busy, run, openModal: setModal, settings: s.effectiveSettings }),
    Object.keys(s.quarantine ?? {}).length > 0 && (0, import_react.createElement)(
      "div",
      { style: c.banner("warn"), "data-testid": "lp-quarantine" },
      (0, import_react.createElement)("strong", null, "Some registry entries were set aside (kept, not used): "),
      Object.entries(s.quarantine).map(([n, q]) => (0, import_react.createElement)("div", { key: n, style: { marginTop: 4 } }, `\u2022 ${n} \u2014 ${q.problems.join("; ")}`)),
      (0, import_react.createElement)("div", { style: c.muted }, 'Nothing was deleted. "Repair installation" rebuilds missing entries from your repos.')
    ),
    s.plugins.length === 0 ? (0, import_react.createElement)("div", { style: { ...c.card, ...c.muted } }, 'No local plugins yet. Use "+ Add" to migrate an installed plugin or set one up from its origin.') : s.plugins.map((p) => (0, import_react.createElement)(PluginCard, { key: p.name, p, run, busy, ctx, close, openModal: setModal, homePath, lastOp: s.lastOp, issues: s.issues })),
    modalEl
  );
}
function NoticePopup({ store, ctx, notice, onDone }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  async function dismiss() {
    setBusy(true);
    await call("dismissNotice", { id: notice.id }).catch(() => {
    });
    store.refresh();
    onDone();
  }
  async function work() {
    setBusy(true);
    try {
      const draft = await call("agentDraft", { name: notice.plugin, mode: "crash" });
      await dismiss();
      await openAgentSession(ctx, draft);
    } catch {
      setBusy(false);
    }
  }
  return (0, import_react.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose: dismiss,
      title: notice.title,
      closeLabel: "Close",
      footer: (0, import_react.createElement)(
        "div",
        { style: c.row },
        (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "ghost", disabled: busy, onClick: dismiss }, "OK"),
        notice.plugin && ["crash-revert", "crash-recovery"].includes(notice.kind) && (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, { variant: "primary", disabled: busy, onClick: work }, "Work on it")
      )
    },
    (0, import_react.createElement)("div", { style: { fontSize: 13, lineHeight: 1.6 }, "data-testid": "lp-popup" }, notice.message)
  );
}
function SidebarBadge({ store, wide, ctx }) {
  const { snapshot } = useStore(store);
  const [seen, setSeen] = (0, import_react.useState)(() => /* @__PURE__ */ new Set());
  const popup = (snapshot?.notices ?? []).find((n2) => CRASH_KINDS.includes(n2.kind) && !seen.has(n2.id));
  const popupEl = popup ? (0, import_react.createElement)(NoticePopup, { key: popup.id, store, ctx, notice: popup, onDone: () => setSeen((x) => new Set(x).add(popup.id)) }) : null;
  const n = attentionCount(snapshot);
  if (!n) return popupEl;
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
  }, (0, import_react.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "warning" }, String(n)), wide ? "Local plugins" : null, popupEl);
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
