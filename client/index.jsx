// dsh-local-plugins web client:
//   - Settings → "Local Plugins": list, add/migrate, update/conflicts, apply/restore,
//     commit, rollback, dependency overrides, Reapply all, Restart
//   - sidebar footer badge: updates + conflicts + restart-needed count
//   - "Work on it" / "Fix with agent": a new dsh session (Creator mode, the `cordis` preset) in the
//     plugin folder with a prefilled, unsent draft
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives';

const name = 'dsh-local-plugins';
const inject = ['slots', 'remote', 'remote.agentPresets'];

const API = '/local-plugins-api';
const SECTION_ID = 'local-plugins';
const SECTION_LABEL = 'Local Plugins';
const AGENT_PRESET = 'cordis'; // Creator mode

// ---------- data ----------

/** POST an action. Every call has a timeout: a request caught by a restarting
 *  server can otherwise hang forever and freeze the poller. */
async function call(action, body = {}, { timeoutMs = 15000 } = {}) {
  const res = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error(`${action}: HTTP ${res.status}`); }
  if (!data.ok) {
    const e = data.error ?? {};
    throw Object.assign(new Error(typeof e === 'string' ? e : e.message ?? `${action} failed`), { code: e.code, details: e.details });
  }
  return data.value;
}

/** One shared poller for the section and the sidebar badge. */
function createStateStore() {
  let snapshot = null;
  let error = null;
  const listeners = new Set();
  let timer = null;
  let inflight = false;
  const emit = () => { for (const l of listeners) l(); };
  async function refresh() {
    if (inflight) return;
    inflight = true;
    try { snapshot = await call('state'); error = null; } catch (err) { error = err.message; }
    inflight = false;
    emit();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!listeners.size) return;
    timer = setTimeout(refresh, snapshot?.op ? 1000 : 15000);
  }
  return {
    get: () => ({ snapshot, error }),
    refresh,
    subscribe(l) {
      listeners.add(l);
      if (listeners.size === 1) refresh();
      return () => { listeners.delete(l); if (!listeners.size) clearTimeout(timer); };
    },
  };
}

function useStore(store) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.get();
}

function attentionCount(s) {
  if (!s) return 0;
  let n = s.restartNeeded ? 1 : 0;
  if (s.upgrade) n++;
  for (const p of s.plugins) if (p.pending || p.update?.available || p.disabled || p.status?.id === 'BROKEN') n++;
  n += (s.notices ?? []).length;
  if (s.registryError) n++;
  return n;
}

// ---------- agent session ----------

async function openAgentSession(ctx, { path, text }) {
  const workspaces = ctx.get('workspaces');
  const sessions = ctx.get('sessions');
  const ws = await workspaces.create({ path });
  const sid = await sessions.create({ workspaceId: ws.workspaceId });
  // Creator mode (the `cordis` preset) is dsh's mode for building and changing plugins, which is what these sessions do.
  // If this dsh has no such preset, fall back to the everyday one rather than failing to open the session.
  for (const preset of [AGENT_PRESET, 'standard']) {
    try {
      const r = await ctx.remote.agentPresets.select(sid, preset);
      if (!r || r.ok !== false) break;
      console.warn(`[dsh-local-plugins] preset "${preset}" refused`, r.error);
    } catch (err) {
      console.warn(`[dsh-local-plugins] preset "${preset}" failed`, err);
    }
  }
  ctx.get('uiWorkspace').openSession(sid);
  ctx.get('conversation').input.for(sessions.scope(sid)).setDraft(text);
  return sid;
}

// ---------- styles ----------

const c = {
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  card: { border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '12px 14px', marginTop: 10, background: 'var(--dsw-alias-bg-layer-1,#fff)' },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  banner: (tone) => ({
    borderLeft: `4px solid ${tone === 'warn' ? 'var(--dsw-alias-state-warn-primary,#b45309)' : tone === 'error' ? 'var(--dsw-alias-state-error-primary,#dc2626)' : 'var(--dsw-alias-brand-primary,#4f6ef7)'}`,
    background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 8, padding: '10px 12px', marginTop: 10, fontSize: 13, lineHeight: 1.5,
  }),
  pre: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11, lineHeight: 1.45, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', borderRadius: 8, padding: 8, margin: '8px 0 0' },
  input: { font: 'inherit', fontSize: 13, height: 32, padding: '0 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', boxSizing: 'border-box' },
  mono: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 },
  list: { maxHeight: 260, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 8, marginTop: 8 },
  listItem: (active) => ({ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13, background: active ? 'var(--dsw-specific-sidebar-nav-item-active,#eef2ff)' : 'transparent' }),
};

const STATUS_TONE = { APPLIED: 'success', CHANGES_PENDING: 'warning', UPDATE_AVAILABLE: 'warning', CONFLICT: 'danger', LINK_LOST: 'warning', REAPPLY_REQUIRED: 'warning', BROKEN: 'danger', DISABLED: 'danger', TRACKED: 'neutral' };
const CRASH_KINDS = ['crash-revert', 'crash-recovery', 'crash-revert-failed', 'registry-rebuilt'];
const short = (sha) => (sha ? String(sha).slice(0, 12) : '—');

function tilde(str, home) {
  if (!str || !home) return str;
  let out = String(str);
  out = out.split(home).join('~');
  out = out.replace(/file:\/\/[^/]+\/~/g, 'file://~/');
  return out;
}

// ---------- section ----------

function useAction(store, setNotice) {
  return useCallback(async (action, body, okText) => {
    try {
      await call(action, body);
      if (okText) setNotice({ tone: 'info', text: okText });
    } catch (err) {
      setNotice({ tone: 'error', text: err.message });
    }
    store.refresh();
  }, [store, setNotice]);
}

const EXPECTED_API = 2;
const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round((n || 0) / 1024))} KB`);
const fmtDur = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const VERB = { apply: 'Applying', update: 'Updating', 'finish update': 'Finishing the update of', 'abort update': 'Aborting the update of', 'restore original': 'Unlinking', commit: 'Committing', 'dependency override': 'Saving a dependency override for', migrate: 'Migrating', add: 'Adding', check: 'Checking for updates', 'reapply all': 'Reapplying', repair: 'Repairing the installation', delete: 'Deleting', cleanup: 'Cleaning up', trust: 'Changing script permission for', 'startup recovery': 'Checking the installation' };
const linkButton = { border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', textDecoration: 'underline', padding: 0, fontSize: 12 };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Progress, success and failure of the current/last operation, with what to do about it. */
function OpPanel({ op, lastOp, run, workOn, plugins }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef(null);
  useEffect(() => { if (!op) return undefined; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [op?.id]);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
  const shown = op ?? lastOp;
  if (!shown || (!op && dismissed === shown.id)) return null;
  const running = shown.status === 'running';
  const failed = shown.status === 'error';
  const label = `${shown.kind}${shown.target ? ` ${shown.target}` : ''}`;
  const elapsed = running ? Date.now() - shown.startedAt : shown.durationMs ?? 0;
  const lastLine = shown.log.length ? shown.log[shown.log.length - 1] : '';
  const plugin = plugins.find((p) => p.name === shown.target);
  const exists = Boolean(plugin);
  const pathToCopy = plugin?.pending?.worktree ?? plugin?.repo ?? null;
  const pathLabel = plugin?.pending ? 'Copy worktree path' : 'Copy repo path';
  const canRetry = failed && shown.request && !shown.needsTrust && shown.errorCode !== 'BUSY';
  const logBox = (open || running) && h('pre', { ref, style: c.pre }, shown.log.slice(-200).join('\n'));
  const logButtons = [
    h('button', { key: 'v', style: linkButton, onClick: () => setOpen(!open) }, open ? 'Hide logs' : 'View logs'),
    h('button', { key: 'c', style: linkButton, onClick: async () => { setCopied(await copyText(shown.log.join('\n'))); setTimeout(() => setCopied(false), 1500); } }, copied ? 'Copied' : 'Copy log'),
  ];

  if (running) {
    return h('div', { style: c.banner('info'), 'data-testid': 'lp-op' },
      h('div', { style: c.row }, h('strong', null, `⏳ ${VERB[shown.kind] ?? shown.kind}${shown.target ? ` ${shown.target}` : ''}…`), h('span', { style: c.muted }, fmtDur(elapsed))),
      lastLine && h('div', { style: { ...c.muted, marginTop: 4 } }, lastLine.slice(0, 160)),
      logBox);
  }
  if (!failed) {
    return h('div', { style: { ...c.muted, marginTop: 10 }, 'data-testid': 'lp-op' },
      `✔ ${label} — done in ${fmtDur(elapsed)} · `, logButtons[0], ' · ', logButtons[1], ' · ', h('button', { style: linkButton, onClick: () => setDismissed(shown.id) }, 'dismiss'), logBox);
  }
  return h('div', { style: c.banner('error'), 'data-testid': 'lp-op' },
    h('div', { style: c.row }, h('strong', null, `✖ ${shown.title ?? 'Failed'}`), shown.target && h('span', { style: c.muted }, shown.target), h('button', { style: { ...linkButton, marginLeft: 'auto' }, onClick: () => setDismissed(shown.id) }, 'dismiss')),
    h('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap' } }, shown.error),
    shown.advice && h('div', { style: { marginTop: 8 } },
      h('div', null, h('strong', null, 'Is it safe? '), shown.advice.safe),
      h('div', { style: { marginTop: 4 } }, h('strong', null, 'What now? '), shown.advice.next)),
    h('div', { style: { ...c.row, marginTop: 8 } },
      canRetry && h(Button, { size: 'sm', variant: 'primary', onClick: () => run(shown.request.action, shown.request.body) }, 'Retry'),
      exists && h(Button, { size: 'sm', variant: 'outline', onClick: () => workOn(shown.target, shown.request?.action === 'finish' ? 'conflict' : 'work') }, 'Work on it'),
      logButtons[0], logButtons[1],
      pathToCopy && h('button', { style: linkButton, onClick: async () => { setCopied(await copyText(pathToCopy)); setTimeout(() => setCopied(false), 1500); }, title: pathToCopy, 'data-testid': 'lp-copy-path' }, pathLabel),
      h('span', { style: c.muted }, `${fmtDur(elapsed)}${shown.errorCode ? ` · ${shown.errorCode}` : ''}`)),
    logBox);
}

/** Recent operations, newest first; click one for its full log. */
function HistoryPanel({ s }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);
  const [full, setFull] = useState(null);
  useEffect(() => {
    if (!open) return;
    call('history').then((v) => setRows(v.operations)).catch(() => {});
  }, [open, s.lastOp?.id, s.op?.id]);
  useEffect(() => {
    if (sel == null) { setFull(null); return; }
    call('op', { id: sel }).then(setFull).catch(() => setFull(null));
  }, [sel]);
  return h('div', { style: { marginTop: 10 } },
    h('button', { style: linkButton, onClick: () => setOpen(!open), 'data-testid': 'lp-history-toggle' }, open ? 'Hide recent operations' : 'Recent operations'),
    open && h('div', { style: { ...c.list, maxHeight: 200 }, 'data-testid': 'lp-history' },
      rows.length === 0 ? h('div', { style: { ...c.muted, padding: 10 } }, 'Nothing has run since dsh started.')
        : rows.map((o) => h('div', { key: o.id, style: c.listItem(sel === o.id), onClick: () => setSel(sel === o.id ? null : o.id) },
          h('span', null, `${o.status === 'ok' ? '✔' : o.status === 'error' ? '✖' : '⏳'} ${o.kind}${o.target ? ` ${o.target}` : ''}`),
          h('span', { style: c.muted }, `${fmtDur(o.durationMs ?? 0)}${o.status === 'error' && o.errorCode ? ` · ${o.errorCode}` : ''}`)))),
    open && full && h('pre', { style: c.pre }, `${full.error ? `${full.error}\n\n` : ''}${full.log.join('\n')}`));
}

/** Disk use per plugin, computed on demand (it walks the folders), plus a safe snapshot cleanup. */
function DiskPanel({ busy, run, openModal, settings }) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(null);
  const [saved, setSaved] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  async function load() { setErr(null); try { setData(await call('diskUsage', {}, { timeoutMs: 60000 })); } catch (e) { setErr(e.message); } }
  useEffect(() => { if (open) load(); }, [open]);
  return h('div', { style: { marginTop: 10 } },
    h('button', { style: linkButton, onClick: () => setOpen(!open), 'data-testid': 'lp-disk-toggle' }, open ? 'Hide disk usage' : 'Disk usage'),
    open && h('div', { style: c.card, 'data-testid': 'lp-disk' },
      err && h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, `Could not measure disk usage: ${err}`),
      !data && !err && h('div', { style: c.muted }, 'Measuring…'),
      data && h('div', null,
        Object.entries(data.plugins).map(([name, u]) => h('div', { key: name, style: { ...c.row, justifyContent: 'space-between', fontSize: 13 } },
          h('span', null, name),
          h('span', { style: c.muted }, `repo ${fmtBytes(u.repo)} · ${u.snapshotCount} snapshot(s) ${fmtBytes(u.snapshots)} · worktrees ${fmtBytes(u.worktrees)} · backups ${fmtBytes(u.backups)}`))),
        h('div', { style: { ...c.row, justifyContent: 'space-between', marginTop: 8, fontSize: 13 } },
          h('strong', null, `Total ${fmtBytes(data.total)}`), h('span', { style: c.muted }, `trash ${fmtBytes(data.trash)}`)),
        settings && h('div', { style: { ...c.row, marginTop: 10, fontSize: 13 }, 'data-testid': 'lp-retention' },
          h('span', null, 'Keep'),
          h('input', { type: 'number', min: 1, max: 20, style: { ...c.input, width: 64 }, disabled: settings.keepFromEnv, value: keep ?? settings.keepSnapshots, onChange: (e) => { setKeep(e.target.value); setSaved(null); }, 'data-testid': 'lp-keep-input' }),
          h('span', null, 'deployments per plugin'),
          h(Button, { size: 'sm', variant: 'outline', disabled: settings.keepFromEnv || keep == null || Number(keep) === settings.keepSnapshots, onClick: async () => { try { await call('setSettings', { keepSnapshots: Number(keep) }); setSaved('Saved'); } catch (e) { setSaved(e.message); } } }, 'Save'),
          saved && h('span', { style: c.muted }, saved),
          h('div', { style: { ...c.muted, width: '100%' } }, settings.keepFromEnv ? 'Set by the LPM_KEEP_SNAPSHOTS environment variable, which overrides this.' : 'The live deployment and the one you can roll back to are always kept, whatever this says.')),
        h('div', { style: { ...c.row, marginTop: 8 } },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => openModal({ kind: 'cleanup' }) }, 'Clean up old snapshots…'),
          h(Button, { size: 'sm', variant: 'ghost', onClick: load }, 'Measure again')))));
}

/** Previews what cleanup would remove (nothing is deleted until you confirm). */
function CleanupModal({ run, onClose }) {
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { call('cleanupPreview', {}, { timeoutMs: 60000 }).then(setPlan).catch((e) => setErr(e.message)); }, []);
  const nothing = plan && plan.snapshots.length === 0;
  return h(Modal, { open: true, onClose, title: 'Clean up old snapshots', closeLabel: 'Close',
    footer: h('div', { style: c.row },
      h(Button, { variant: 'ghost', onClick: onClose }, 'Cancel'),
      h(Button, { variant: 'primary', disabled: !plan || nothing, onClick: () => { run('cleanup', { execute: true }); onClose(); } }, plan && !nothing ? `Remove ${plan.snapshots.length} (${fmtBytes(plan.bytes)})` : 'Remove')) },
  h('div', { style: { fontSize: 13, lineHeight: 1.6 } },
    err ? `Could not prepare the preview: ${err}` : !plan ? 'Working out what can be removed…' : nothing ? 'Nothing to clean up: every snapshot is either live, the rollback target, or within the retention limit.'
      : h('div', null, 'These deployments are older than the retention limit. The live one and the rollback target are never removed, and any of them can be rebuilt from git:',
        h('ul', { style: { margin: '8px 0 0 18px', padding: 0 } }, plan.snapshots.map((x) => h('li', { key: `${x.kind ?? 'snapshot'}-${x.name}`, style: c.mono }, `${x.kind === 'worktree' ? '(leftover trial merge) ' : ''}${x.name} — ${fmtBytes(x.bytes)}`))))));
}

/** Typed confirmation: stop tracking a plugin; the repo moves to the trash and can be moved back. */
function DeleteModal({ plugin, run, onClose }) {
  const [typed, setTyped] = useState('');
  return h(Modal, { open: true, onClose, title: `Delete local plugin ${plugin.name}?`, closeLabel: 'Close',
    footer: h('div', { style: c.row },
      h(Button, { variant: 'ghost', onClick: onClose }, 'Cancel'),
      h(Button, { variant: 'primary', disabled: typed !== plugin.name, onClick: () => { run('delete', { name: plugin.name, confirmName: typed }); onClose(); } }, 'Delete')) },
  h('div', { style: { fontSize: 13, lineHeight: 1.6 } },
    h('p', { style: { marginTop: 0 } }, 'This stops tracking the plugin. dsh is not affected (it already has the original back).'),
    h('p', null, 'Your repo, with every commit and stash, is ', h('strong', null, 'moved to the trash folder'), ' (not deleted) and can be moved back; deployment snapshots are removed because they can be rebuilt.'),
    h('p', null, `Type ${plugin.name} to confirm:`),
    h('input', { style: { ...c.input, width: '100%' }, value: typed, placeholder: plugin.name, onChange: (e) => setTyped(e.target.value), 'data-testid': 'lp-delete-input' })));
}

function PluginCard({ p, run, busy, ctx, close, openModal, homePath, lastOp, issues }) {
  const stats = p.stats ?? {};
  const state = p.applied ? (p.linkLost ? 'Link lost' : 'Applied') : 'Tracked only';
  const tone = p.applied ? (p.linkLost ? 'warning' : 'success') : 'neutral';
  const st = p.status;
  const allows = (a) => !st || st.allowed.includes(a);
  // a disabled plugin offers only "Work on it" until something new has been committed
  const fixedSinceCrash = !p.disabled || (stats.head && stats.head !== p.lastCrash?.localHead) || stats.uncommitted > 0;
  const myIssues = (issues ?? []).filter((i) => i.plugin === p.name && i.severity !== 'info');
  const [agentErr, setAgentErr] = useState(null);
  // the last operation on this plugin stopped because it needs permission to run scripts
  const trustAsk = lastOp && lastOp.status === 'error' && lastOp.needsTrust && lastOp.request && lastOp.target === p.name ? lastOp : null;

  async function agent(mode) {
    setAgentErr(null);
    try {
      const draft = await call('agentDraft', { name: p.name, mode });
      close?.();
      await openAgentSession(ctx, draft);
    } catch (err) {
      setAgentErr(err.message);
    }
  }

  return h('div', { style: c.card, 'data-testid': `lp-card-${p.name}` },
    h('div', { style: c.row },
      h('strong', { style: { fontSize: 14 } }, p.name),
      h(Tag, { tone: p.kind === 'core' ? 'info' : 'outline' }, p.kind === 'core' ? 'core' : 'third-party'),
      h(Tag, { tone: st ? STATUS_TONE[st.id] ?? tone : tone }, st ? `${st.label}${st.id === 'UPDATE_AVAILABLE' && p.update?.target && p.update.target !== 'upstream' ? ` ${short(p.update.target)}` : ''}` : state),
      p.trustScripts && h(Tag, { tone: 'warning' }, 'Scripts always allowed')),
    h('div', { style: { ...c.muted, marginTop: 4 } }, h('button', { style: { ...linkButton, float: 'right' }, onClick: () => copyText(p.pending?.worktree ?? p.repo), title: p.pending?.worktree ?? p.repo, 'data-testid': `lp-path-${p.name}` }, p.pending ? 'Copy worktree path' : 'Copy repo path'), p.source.type === 'git' ? `git · ${tilde(p.source.url, homePath)}` : `npm · ${p.source.name}`),
    h('div', { style: { fontSize: 12, marginTop: 6, lineHeight: 1.6 } },
      h('span', { 'data-testid': 'lp-changed' }, `${stats.changedVsOriginal ?? '?'} file(s) changed vs original`),
      stats.uncommitted ? h('span', null, ` · ${stats.uncommitted} uncommitted`) : null,
      ' · ',
      p.applied
        ? h('span', { 'data-testid': 'lp-running' }, `running ${short(p.deployedSha)}${stats.notApplied ? ` · ${stats.notApplied} newer commit(s) not applied` : ''}`)
        : h('span', null, `local ${short(stats.head)}`),
      p.update?.error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, `update check failed: ${p.update.error}`) : null,
      p.lastError ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, `last error: ${p.lastError}`) : null),

    p.pending && h('div', { style: c.banner('error'), 'data-testid': 'lp-conflict' },
      h('div', null, h('strong', null, 'Update stopped on conflicts. '), 'Your live plugin is unchanged.'),
      h('div', { style: { ...c.mono, margin: '6px 0' } }, p.pending.conflicts.map((f) => h('div', { key: f }, `• ${f}`))),
      h('div', { style: c.muted }, `Resolve in ${tilde(p.pending.worktree, homePath)}`),
      h('div', { style: { ...c.row, marginTop: 8 } },
        h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => run('finish', { name: p.name }) }, 'Finish update'),
        h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => agent('conflict') }, 'Fix with agent'),
        h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'confirm', title: `Abort the update of ${p.name}?`, body: 'The merge attempt is thrown away. Your local branch and the live plugin stay as they are.', action: () => run('abort', { name: p.name }) }) }, 'Abort'))),

    p.disabled && h('div', { style: c.banner('error'), 'data-testid': 'lp-disabled' },
      h('strong', null, 'Disabled — it crashed dsh. '), 'It was taken out of dsh so dsh can start. Your repo and commits are untouched. Use "Work on it" to fix it with an agent, commit the fix, then Apply becomes available.'),

    myIssues.length > 0 && h('div', { style: c.banner(myIssues.some((i) => i.severity === 'error') ? 'error' : 'warn'), 'data-testid': 'lp-issues' },
      h('div', null, myIssues.map((i) => h('div', { key: i.code }, `• ${i.message}`))),
      h('div', { style: { marginTop: 6 } }, h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run('repair', {}) }, 'Repair installation'))),

    trustAsk && h('div', { style: c.banner('error'), 'data-testid': 'lp-trust' },
      h('div', null, h('strong', null, 'Permission needed. '), `${p.name} wants to run scripts on your computer, with your full access:`),
      h('ul', { style: { margin: '6px 0 6px 18px', padding: 0, fontSize: 12 } }, trustAsk.needsTrust.map((r) => h('li', { key: r }, r))),
      h('div', { style: c.muted }, 'Only continue if you trust this plugin and its publisher. Nothing has gone live yet.'),
      h('div', { style: { ...c.row, marginTop: 8 } },
        h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => run(trustAsk.request.action, { ...trustAsk.request.body, allowScripts: true }) }, 'Allow this time'),
        h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run(trustAsk.request.action, { ...trustAsk.request.body, alwaysAllow: true }) }, 'Always allow for this plugin'))),

    h('div', { style: { ...c.row, marginTop: 10 } },
      allows('apply') && fixedSinceCrash && h(Button, { size: 'sm', variant: st?.primary === 'apply' || !st ? 'primary' : 'outline', disabled: busy || Boolean(p.pending), onClick: () => (p.kind === 'core' && !p.applied ? openModal({ kind: 'confirm', title: `Replace the built-in ${p.name}?`, body: 'This changes a package inside your dsh installation: the original folder is moved to a backup and replaced by a link to your version. "Unlink" puts the original back, and if dsh crashes after this the original is restored automatically. Continue?', action: () => run('apply', { name: p.name }) }) : run('apply', { name: p.name })) }, p.applied ? 'Apply latest commit' : 'Apply'),
      p.update?.available && allows('update') && h(Button, { size: 'sm', variant: st?.primary === 'update' ? 'primary' : 'outline', disabled: busy, onClick: () => run('update', { name: p.name }) }, 'Update'),
      p.applied && allows('restore') && h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => openModal({ kind: 'confirm', title: `Unlink ${p.name} and restore the original?`, body: p.kind === 'core' ? 'dsh goes back to the built-in package that shipped with it. Your local repo stays tracked — click Apply to switch back.' : "dsh reinstalls the original version spec it had before (for example ^1.0.0). Your local repo stays tracked — click Apply to switch back.", action: () => run('restore', { name: p.name }) }) }, 'Unlink (restore original)'),
      allows('delete') && !p.applied && h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'delete', plugin: p }), 'data-testid': `lp-delete-${p.name}` }, 'Delete…'),
      allows('commit') && h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'commit', plugin: p }) }, 'Commit'),
      allows('rollback') && !p.disabled && h(Button, { size: 'sm', variant: st?.primary === 'rollback' ? 'outline' : 'ghost', disabled: busy, onClick: () => openModal({ kind: 'rollback', plugin: p }) }, 'Deploy older commit…'),
      allows('setDep') && !p.disabled && h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'deps', plugin: p }) }, 'Dependency overrides'),
      p.trustScripts && h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run('trust', { name: p.name, trust: false }) }, 'Revoke script permission'),
      h(Button, { size: 'sm', variant: p.disabled ? 'primary' : 'ghost', onClick: () => agent(p.disabled ? 'crash' : 'work') }, 'Work on it')),
    agentErr && h('div', { style: { ...c.muted, color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 6 } }, `Could not open agent session: ${agentErr}`));
}

function AddModal({ onClose, run }) {
  const [tab, setTab] = useState('migrate');
  const [installed, setInstalled] = useState(null);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState(null);
  const [origin, setOrigin] = useState('auto');
  const [input, setInput] = useState('');
  useEffect(() => { call('installed').then(setInstalled, (e) => setInstalled({ error: e.message })); }, []);
  const items = useMemo(() => {
    if (!installed || installed.error) return [];
    const all = [
      ...installed.profile.map((x) => ({ name: x.name, kind: 'third-party', detail: x.version ?? x.spec })),
      ...installed.core.map((n) => ({ name: n, kind: 'core', detail: 'built-in' })),
    ];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((x) => x.name.toLowerCase().includes(f)) : all;
  }, [installed, filter]);

  const footer = tab === 'migrate'
    ? h(Button, { variant: 'primary', disabled: !picked, onClick: () => { run('migrate', { name: picked.name, origin }); onClose(); } }, 'Migrate to local')
    : h(Button, { variant: 'primary', disabled: !input.trim(), onClick: () => { run('add', { input }); onClose(); } }, 'Add locally');

  return h(Modal, { open: true, onClose, title: 'Add a local plugin', closeLabel: 'Close', footer },
    h('div', { style: { ...c.row, marginBottom: 10 } },
      h(Button, { size: 'sm', variant: tab === 'migrate' ? 'primary' : 'outline', onClick: () => setTab('migrate') }, 'Migrate installed'),
      h(Button, { size: 'sm', variant: tab === 'new' ? 'primary' : 'outline', onClick: () => setTab('new') }, 'New from origin')),
    tab === 'migrate'
      ? h('div', null,
        h('div', { style: c.muted }, 'Copies an installed plugin into its own git repo. Nothing changes in dsh until you click Apply.'),
        h('input', { style: { ...c.input, width: '100%', marginTop: 8 }, placeholder: 'Filter…', value: filter, onChange: (e) => setFilter(e.target.value), 'data-testid': 'lp-add-filter' }),
        installed?.error ? h('div', { style: c.banner('error') }, installed.error) : null,
        h('div', { style: c.list }, !installed ? h('div', { style: { ...c.muted, padding: 10 } }, 'Loading…')
          : items.map((x) => h('div', { key: x.name, style: c.listItem(picked?.name === x.name), onClick: () => setPicked(x), 'data-testid': `lp-pick-${x.name}` },
            h('span', null, x.name), h('span', { style: c.muted }, `${x.kind} · ${x.detail}`)))),
        picked?.kind === 'third-party' && h('div', { style: { ...c.row, marginTop: 10, fontSize: 13 } },
          'Origin:',
          ['auto', 'git', 'npm'].map((o) => h('label', { key: o, style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
            h('input', { type: 'radio', name: 'lp-origin', checked: origin === o, onChange: () => setOrigin(o) }), o === 'auto' ? 'auto (git if reachable)' : o))))
      : h('div', null,
        h('div', { style: c.muted }, 'An npm package name (e.g. dsh-foo, @scope/pkg) or a git URL (https://github.com/user/repo). It is set up locally but not applied.'),
        h('input', { style: { ...c.input, width: '100%', marginTop: 8 }, placeholder: 'npm name or git URL', value: input, onChange: (e) => setInput(e.target.value), 'data-testid': 'lp-add-input' })));
}

function CommitModal({ plugin, onClose, run }) {
  const [msg, setMsg] = useState('');
  return h(Modal, { open: true, onClose, title: `Commit ${plugin.name}`, closeLabel: 'Close',
    footer: h(Button, { variant: 'primary', onClick: () => { run('commit', { name: plugin.name, message: msg }); onClose(); } }, 'Commit') },
  h('div', { style: c.muted }, `${plugin.stats?.uncommitted ?? 0} uncommitted file(s). Committing does not deploy — click Apply for that.`),
  h('input', { style: { ...c.input, width: '100%', marginTop: 8 }, placeholder: 'Message (optional)', value: msg, onChange: (e) => setMsg(e.target.value) }));
}

function RollbackModal({ plugin, onClose, run }) {
  const [commits, setCommits] = useState(null);
  const [picked, setPicked] = useState(null);
  useEffect(() => { call('commits', { name: plugin.name }).then((r) => setCommits(r.commits), (e) => setCommits({ error: e.message })); }, [plugin.name]);
  return h(Modal, { open: true, onClose, title: `Deploy a commit of ${plugin.name}`, closeLabel: 'Close',
    footer: h(Button, { variant: 'primary', disabled: !picked, onClick: () => { run('apply', { name: plugin.name, ref: picked }); onClose(); } }, 'Deploy this commit') },
  h('div', { style: c.muted }, 'dsh runs exactly the commit you pick (restart to load it).'),
  h('div', { style: c.list }, !commits ? h('div', { style: { ...c.muted, padding: 10 } }, 'Loading…')
    : commits.error ? h('div', { style: { padding: 10 } }, commits.error)
      : commits.map((x) => h('div', { key: x.sha, style: c.listItem(picked === x.sha), onClick: () => setPicked(x.sha) },
        h('span', null, h('span', { style: c.mono }, short(x.sha)), ' ', x.subject, x.sha === plugin.deployedSha ? ' (running)' : ''),
        h('span', { style: c.muted }, new Date(x.date).toLocaleString())))));
}

function DepsModal({ plugin, onClose, run }) {
  const [dep, setDep] = useState('');
  const [range, setRange] = useState('latest');
  const entries = Object.entries(plugin.depOverrides ?? {});
  return h(Modal, { open: true, onClose, title: `Dependency overrides — ${plugin.name}`, closeLabel: 'Close',
    footer: h(Button, { variant: 'primary', disabled: !dep.trim(), onClick: () => { run('setDep', { name: plugin.name, dep: dep.trim(), range: range.trim() || 'latest' }); onClose(); } }, 'Save override') },
  h('div', { style: c.muted }, 'Changes the dependency range in the plugin\'s package.json as a commit. It takes effect on Apply' + (plugin.kind === 'core' ? ' (the dependency is installed into the dsh install).' : ' (installed into the snapshot).')),
  entries.length ? h('div', { style: { marginTop: 8 } }, entries.map(([d, r]) => h('div', { key: d, style: { ...c.row, fontSize: 13 } },
    h('span', { style: c.mono }, `${d} → ${r}`),
    h(Button, { size: 'sm', variant: 'ghost', onClick: () => { run('setDep', { name: plugin.name, dep: d, range: null }); onClose(); } }, 'Remove')))) : null,
  h('div', { style: { ...c.row, marginTop: 10 } },
    h('input', { style: { ...c.input, flex: 2 }, placeholder: 'dependency, e.g. @earendil-works/pi-ai', value: dep, onChange: (e) => setDep(e.target.value) }),
    h('input', { style: { ...c.input, flex: 1 }, placeholder: 'range', value: range, onChange: (e) => setRange(e.target.value) })));
}

function ConfirmModal({ title, body, action, onClose }) {
  return h(Modal, { open: true, onClose, title, closeLabel: 'Close',
    footer: h('div', { style: c.row },
      h(Button, { variant: 'ghost', onClick: onClose }, 'Cancel'),
      h(Button, { variant: 'primary', onClick: () => { action(); onClose(); } }, 'Continue')) },
  h('div', { style: { fontSize: 13, lineHeight: 1.6 } }, body));
}

function LocalPluginsSection({ store, ctx, close }) {
  const { snapshot: s, error } = useStore(store);
  const [notice, setNotice] = useState(null);
  const [modal, setModal] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const run = useAction(store, setNotice);
  const busy = Boolean(s?.op);

  /** Open a dsh agent session in the plugin's repo (or its update worktree) with a prefilled, unsent prompt. */
  async function workOn(name, mode = 'work') {
    try {
      const draft = await call('agentDraft', { name, mode });
      close?.();
      await openAgentSession(ctx, draft);
    } catch (err) {
      setNotice({ tone: 'error', text: `Could not open an agent session: ${err.message}` });
    }
  }

  async function restart() {
    setRestarting(true);
    try {
      const before = s.bootId;
      await call('restart');
      // reload once a *new* server process answers (its bootId differs)
      const started = Date.now();
      const poll = async () => {
        try {
          const next = await call('state', {}, { timeoutMs: 3000 });
          if (next.bootId && next.bootId !== before) { location.reload(); return; }
        } catch { /* down or restarting */ }
        if (Date.now() - started > 120000) {
          setRestarting(false);
          setNotice({ tone: 'error', text: 'dsh web did not come back within 2 minutes — check the restart log in $DSH_HOME/logs.' });
          return;
        }
        setTimeout(poll, 1000);
      };
      setTimeout(poll, 1000);
    } catch (err) {
      setRestarting(false);
      setNotice({ tone: 'error', text: err.message });
    }
  }

  const homePath = s?.env?.home ?? '';

  if (!s) return h('div', { style: c.muted }, error ? `Could not load: ${error}` : 'Loading…');

  const modalEl = !modal ? null
    : modal.kind === 'add' ? h(AddModal, { onClose: () => setModal(null), run })
      : modal.kind === 'commit' ? h(CommitModal, { plugin: modal.plugin, onClose: () => setModal(null), run })
        : modal.kind === 'rollback' ? h(RollbackModal, { plugin: modal.plugin, onClose: () => setModal(null), run })
          : modal.kind === 'deps' ? h(DepsModal, { plugin: modal.plugin, onClose: () => setModal(null), run })
            : modal.kind === 'delete' ? h(DeleteModal, { plugin: modal.plugin, onClose: () => setModal(null), run })
              : modal.kind === 'cleanup' ? h(CleanupModal, { onClose: () => setModal(null), run })
            : h(ConfirmModal, { ...modal, onClose: () => setModal(null) });

  return h('div', { 'data-testid': 'lp-section', style: { maxWidth: 720 } },
    s.apiVersion !== EXPECTED_API && h('div', { style: c.banner('error'), 'data-testid': 'lp-version' },
      h('strong', null, 'This page is out of date. '), `It speaks API ${EXPECTED_API} but the server speaks ${s.apiVersion ?? 'an older version'}. Reload the page.`,
      h('div', { style: { marginTop: 8 } }, h(Button, { size: 'sm', variant: 'primary', onClick: () => location.reload() }, 'Reload'))),
    h('div', { style: { ...c.row, justifyContent: 'space-between' } },
      h('div', null,
        h('div', { style: { fontSize: 16, fontWeight: 500 } }, 'Local Plugins'),
        h('div', { style: c.muted }, `Edited plugins kept as git repos in ${tilde(s.env.root, homePath)}. dsh only runs committed code — Apply deploys a commit.`)),
      h('div', { style: c.row },
        h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run('repair', {}), title: 'Finish or roll back interrupted operations and make the registry match what is on disk' }, 'Repair installation'),
        h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run('check', {}) }, 'Check now'),
        h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => setModal({ kind: 'add' }) }, '+ Add'))),

    s.upgrade && h('div', { style: c.banner('warn'), 'data-testid': 'lp-upgrade' },
      h('strong', null, s.upgrade.from && s.upgrade.to && s.upgrade.from !== s.upgrade.to ? `dsh upgraded ${s.upgrade.from} → ${s.upgrade.to}. ` : 'dsh was reinstalled. '),
      `${s.upgrade.lost} applied plugin link(s) were reset to the original. Reapply all checks every origin for updates first, then re-links.`,
      h('div', { style: { marginTop: 8 } }, h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => run('reapplyAll', {}) }, 'Reapply all'))),

    s.restartNeeded && h('div', { style: c.banner('info'), 'data-testid': 'lp-restart' },
      h('strong', null, 'Restart needed. '), 'Changes load when dsh web restarts (open chats reconnect).',
      h('div', { style: { marginTop: 8 } }, h(Button, { size: 'sm', variant: 'primary', disabled: busy || restarting, onClick: restart }, restarting ? 'Restarting…' : 'Restart dsh web'))),

    notice && h('div', { style: c.banner(notice.tone === 'error' ? 'error' : 'info') },
      notice.text, ' ', h('button', { style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: 'inherit' }, onClick: () => setNotice(null) }, '✕')),

    s.registryError && h('div', { style: c.banner('error'), 'data-testid': 'lp-registry-error' },
      h('strong', null, 'The plugin registry cannot be read. '), s.registryError.message,
      s.registryError.code !== 'REGISTRY_TOO_NEW' && h('div', { style: { marginTop: 8 } }, h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => run('repair', {}) }, 'Repair installation'))),

    (s.notices ?? []).map((n) => h('div', { key: n.id, style: c.banner(n.kind === 'info' ? 'info' : n.kind === 'crash-recovery' ? 'warn' : 'error'), 'data-testid': 'lp-notice' },
      h('div', null, h('strong', null, n.title)),
      h('div', { style: { marginTop: 4, fontSize: 12, lineHeight: 1.5 } }, n.message),
      h('div', { style: { ...c.row, marginTop: 6 } },
        h(Button, { size: 'sm', variant: 'outline', onClick: async () => { await call('dismissNotice', { id: n.id }).catch(() => {}); store.refresh(); } }, 'Dismiss')))),

    h(OpPanel, { op: s.op, lastOp: s.lastOp, run, workOn, plugins: s.plugins }),
    h(HistoryPanel, { s }),
    h(DiskPanel, { busy, run, openModal: setModal, settings: s.effectiveSettings }),

    Object.keys(s.quarantine ?? {}).length > 0 && h('div', { style: c.banner('warn'), 'data-testid': 'lp-quarantine' },
      h('strong', null, 'Some registry entries were set aside (kept, not used): '),
      Object.entries(s.quarantine).map(([n, q]) => h('div', { key: n, style: { marginTop: 4 } }, `• ${n} — ${q.problems.join('; ')}`)),
      h('div', { style: c.muted }, 'Nothing was deleted. "Repair installation" rebuilds missing entries from your repos.')),

    s.plugins.length === 0
      ? h('div', { style: { ...c.card, ...c.muted } }, 'No local plugins yet. Use "+ Add" to migrate an installed plugin or set one up from its origin.')
      : s.plugins.map((p) => h(PluginCard, { key: p.name, p, run, busy, ctx, close, openModal: setModal, homePath, lastOp: s.lastOp, issues: s.issues })),
    modalEl);
}

function NoticePopup({ store, ctx, notice, onDone }) {
  const [busy, setBusy] = useState(false);
  async function dismiss() {
    setBusy(true);
    await call('dismissNotice', { id: notice.id }).catch(() => {});
    store.refresh();
    onDone();
  }
  async function work() {
    setBusy(true);
    try {
      const draft = await call('agentDraft', { name: notice.plugin, mode: 'crash' });
      await dismiss();
      await openAgentSession(ctx, draft);
    } catch { setBusy(false); }
  }
  return h(Modal, { open: true, onClose: dismiss, title: notice.title, closeLabel: 'Close',
    footer: h('div', { style: c.row },
      h(Button, { variant: 'ghost', disabled: busy, onClick: dismiss }, 'OK'),
      notice.plugin && ['crash-revert', 'crash-recovery'].includes(notice.kind) && h(Button, { variant: 'primary', disabled: busy, onClick: work }, 'Work on it')) },
  h('div', { style: { fontSize: 13, lineHeight: 1.6 }, 'data-testid': 'lp-popup' }, notice.message));
}

function SidebarBadge({ store, wide, ctx }) {
  const { snapshot } = useStore(store);
  const [seen, setSeen] = useState(() => new Set());
  const popup = (snapshot?.notices ?? []).find((n) => CRASH_KINDS.includes(n.kind) && !seen.has(n.id));
  const popupEl = popup ? h(NoticePopup, { key: popup.id, store, ctx, notice: popup, onDone: () => setSeen((x) => new Set(x).add(popup.id)) }) : null;
  const n = attentionCount(snapshot);
  if (!n) return popupEl;
  // Settings exposes no "open section" API to plugins, and the `settings.open`
  // shortcut is ignored when invoked from a plugin, so drive the shell's own
  // controls: the sidebar Settings trigger, then our nav entry.
  const open = () => {
    const pickSection = (tries = 0) => {
      const cell = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === SECTION_LABEL);
      if (cell) cell.click(); else if (tries < 40) setTimeout(() => pickSection(tries + 1), 50);
    };
    const trigger = document.querySelector('button[aria-label="Settings"][aria-haspopup="dialog"]');
    if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    setTimeout(pickSection, 50);
  };
  return h('button', {
    'data-testid': 'lp-badge',
    title: `${n} local plugin item(s) need attention`,
    onClick: open,
    style: { display: 'flex', alignItems: 'center', gap: 6, width: wide ? '100%' : 36, height: 32, border: 'none', background: 'none', cursor: 'pointer', padding: wide ? '0 8px' : 0, justifyContent: wide ? 'flex-start' : 'center', color: 'var(--dsw-alias-label-primary,inherit)', fontSize: 13, borderRadius: 8 },
  }, h(Tag, { tone: 'warning' }, String(n)), wide ? 'Local plugins' : null, popupEl);
}

export function apply(ctx) {
  const store = createStateStore();
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: SECTION_ID,
      order: 45,
      label: () => SECTION_LABEL,
      inject: () => ({ store, ctx }),
    },
    LocalPluginsSection,
  ));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'local-plugins-badge',
      order: 60,
      inject: () => ({ store, ctx }),
    },
    SidebarBadge,
  ));
}

export { name, inject };
