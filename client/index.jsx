// dsh-local-plugins web client:
//   - Settings → "Local Plugins": list, add/migrate, update/conflicts, apply/restore,
//     commit, rollback, dependency overrides, Reapply all, Restart
//   - sidebar footer badge: updates + conflicts + restart-needed count
//   - "Work on it" / "Fix with agent": a new dsh session (standard preset) in the
//     plugin folder with a prefilled, unsent draft
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives';

const name = 'dsh-local-plugins';
const inject = ['slots', 'remote', 'remote.agentPresets'];

const API = '/local-plugins-api';
const SECTION_ID = 'local-plugins';
const SECTION_LABEL = 'Local Plugins';

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
  if (!data.ok) throw new Error(data.error ?? `${action} failed`);
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
  for (const p of s.plugins) if (p.pending || p.update?.available) n++;
  return n;
}

// ---------- agent session ----------

async function openAgentSession(ctx, { path, text }) {
  const workspaces = ctx.get('workspaces');
  const sessions = ctx.get('sessions');
  const ws = await workspaces.create({ path });
  const sid = await sessions.create({ workspaceId: ws.workspaceId });
  try {
    const r = await ctx.remote.agentPresets.select(sid, 'standard');
    if (r && r.ok === false) console.warn('[dsh-local-plugins] preset select refused', r.error);
  } catch (err) {
    console.warn('[dsh-local-plugins] preset select failed', err);
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

function OpPanel({ op, lastOp }) {
  const [open, setOpen] = useState(false);
  const shown = op ?? (lastOp?.status === 'error' || open ? lastOp : null);
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
  if (!shown && !lastOp) return null;
  if (!shown) {
    return h('div', { style: { ...c.muted, marginTop: 10 } },
      `Last: ${lastOp.kind}${lastOp.target ? ` ${lastOp.target}` : ''} — ${lastOp.status} `,
      h('button', { style: { border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', textDecoration: 'underline', padding: 0, fontSize: 12 }, onClick: () => setOpen(true) }, 'show log'));
  }
  const tone = shown.status === 'error' ? 'error' : shown.status === 'running' ? 'info' : 'info';
  return h('div', { style: c.banner(tone), 'data-testid': 'lp-op' },
    h('div', { style: c.row },
      h('strong', null, shown.status === 'running' ? '⏳ Running: ' : shown.status === 'error' ? '✖ Failed: ' : '✔ Done: '),
      h('span', null, `${shown.kind}${shown.target ? ` ${shown.target}` : ''}`),
      !op && h('button', { style: { marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12 }, onClick: () => setOpen(false) }, 'hide')),
    shown.error && h('div', { style: { marginTop: 4 } }, shown.error),
    h('pre', { ref, style: c.pre }, shown.log.slice(-200).join('\n')));
}

function PluginCard({ p, run, busy, ctx, close, openModal, homePath }) {
  const stats = p.stats ?? {};
  const state = p.applied ? (p.linkLost ? 'Link lost' : 'Applied') : 'Tracked only';
  const tone = p.applied ? (p.linkLost ? 'warning' : 'success') : 'neutral';
  const [agentErr, setAgentErr] = useState(null);

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
      h(Tag, { tone }, state),
      p.update?.available && !p.pending && h(Tag, { tone: 'warning' }, `Update available ${p.update.target && p.update.target !== 'upstream' ? short(p.update.target) : ''}`),
      p.pending && h(Tag, { tone: 'danger' }, 'Conflict')),
    h('div', { style: { ...c.muted, marginTop: 4 } }, p.source.type === 'git' ? `git · ${tilde(p.source.url, homePath)}` : `npm · ${p.source.name}`),
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

    h('div', { style: { ...c.row, marginTop: 10 } },
      h(Button, { size: 'sm', variant: 'primary', disabled: busy || Boolean(p.pending), onClick: () => run('apply', { name: p.name }) }, p.applied ? 'Apply latest commit' : 'Apply'),
      p.update?.available && !p.pending && h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run('update', { name: p.name }) }, 'Update'),
      p.applied && h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => openModal({ kind: 'confirm', title: `Restore the original ${p.name}?`, body: p.kind === 'core' ? 'dsh goes back to the built-in package that shipped with it. Your local repo stays tracked — click Apply to switch back.' : "dsh installs the original's latest release. Your local repo stays tracked — click Apply to switch back.", action: () => run('restore', { name: p.name }) }) }, 'Restore original'),
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'commit', plugin: p }) }, 'Commit'),
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'rollback', plugin: p }) }, 'Deploy older commit…'),
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => openModal({ kind: 'deps', plugin: p }) }, 'Dependency overrides'),
      h(Button, { size: 'sm', variant: 'ghost', onClick: () => agent('work') }, 'Work on it')),
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
            : h(ConfirmModal, { ...modal, onClose: () => setModal(null) });

  return h('div', { 'data-testid': 'lp-section', style: { maxWidth: 720 } },
    h('div', { style: { ...c.row, justifyContent: 'space-between' } },
      h('div', null,
        h('div', { style: { fontSize: 16, fontWeight: 500 } }, 'Local Plugins'),
        h('div', { style: c.muted }, `Edited plugins kept as git repos in ${tilde(s.env.root, homePath)}. dsh only runs committed code — Apply deploys a commit.`)),
      h('div', { style: c.row },
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

    h(OpPanel, { op: s.op, lastOp: s.lastOp }),

    s.plugins.length === 0
      ? h('div', { style: { ...c.card, ...c.muted } }, 'No local plugins yet. Use "+ Add" to migrate an installed plugin or set one up from its origin.')
      : s.plugins.map((p) => h(PluginCard, { key: p.name, p, run, busy, ctx, close, openModal: setModal, homePath })),
    modalEl);
}

function SidebarBadge({ store, wide }) {
  const { snapshot } = useStore(store);
  const n = attentionCount(snapshot);
  if (!n) return null;
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
  }, h(Tag, { tone: 'warning' }, String(n)), wide ? 'Local plugins' : null);
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
