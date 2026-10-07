// Runtime facts the manager needs, derived from the running dsh process instead
// of hard-coded paths, so the same code drives the real install and the
// isolated test copy (different DSH_HOME, profile, and node_modules layout).
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Profile booted by `dsh <name>` / `dsh --profile <name>`. */
export function profileFromArgv(argv = process.argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--profile') return args[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  if (args[0] && !args[0].startsWith('-')) return args[0];
  return 'web';
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

/** Walk up from `start` to the package.json named `name`. */
function findPackageRoot(start, name) {
  let dir = start;
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try { if (readJson(pj).name === name) return dir; } catch { /* keep walking */ }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The `@deepseek-ai/dsh` package that booted this process. */
export function detectDshInstall(argv = process.argv) {
  const entry = argv[1] ? realpathSync(argv[1]) : null;
  const root = entry ? findPackageRoot(dirname(entry), '@deepseek-ai/dsh') : null;
  if (!root) return null;
  return { root, version: readJson(join(root, 'package.json')).version, bin: join(root, 'lib', 'bin.js') };
}

/** Plugin names are used as directory names: `@scope/pkg` -> `@scope__pkg`. */
export function safeName(name) {
  return name.replace(/\//g, '__');
}

/**
 * @param {{dshHome?:string, profile?:string, dsh?:{root:string,version:string,bin:string}}} [over]
 */
export function createEnv(over = {}) {
  const dshHome = resolve(over.dshHome ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')));
  const profile = over.profile ?? profileFromArgv();
  const dsh = over.dsh ?? detectDshInstall();
  const root = join(dshHome, 'local-plugins');
  const env = {
    dshHome,
    profile,
    profileDir: join(dshHome, 'profiles', profile),
    dsh,
    root,
    registryFile: join(root, 'registry.json'),
    deployedDir: join(root, '.deployed'),
    workDir: join(root, '.work'),
    backupDir: join(root, '.backup'),
    txnDir: join(root, '.txn'),
    repoDir: (name) => join(root, safeName(name)),
    stableLink: (name) => join(root, '.deployed', safeName(name)),

    /** Where Node resolves a core package from dsh's point of view. */
    coreLocation(pkg) {
      if (!dsh) return null;
      const req = createRequire(join(dsh.root, 'package.json'));
      for (const dir of req.resolve.paths(pkg) ?? []) {
        const p = join(dir, pkg);
        if (lexists(p)) return { path: p, nodeModules: dir };
      }
      return null;
    },

    /** All `@deepseek-ai/*` packages visible to dsh (candidates for core overrides). */
    listCorePackages() {
      const base = env.coreLocation('@deepseek-ai/dsh-base');
      if (!base) return [];
      const scopeDir = join(base.nodeModules, '@deepseek-ai');
      return readdirSync(scopeDir).filter((n) => !n.startsWith('.')).map((n) => `@deepseek-ai/${n}`).sort();
    },

    profilePackageJson() {
      return readJson(join(env.profileDir, 'package.json'));
    },
  };
  return env;
}
