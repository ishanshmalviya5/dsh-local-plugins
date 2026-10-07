// What the package validator treats as "private": home-directory paths, the maintainer's own account name,
// and any extra words listed in LPM_PRIVATE_TERMS. Nothing personal is hardcoded.
//
// The account name is only a meaningful signal on a personal machine. On CI the account is a generic name
// (`runner`, `ubuntu`, `root`...) that is also an everyday word in documentation ("test runner"), so it is skipped there,
// as are very short names, and matches are whole-word only.
const GENERIC_ACCOUNTS = new Set(['runner', 'root', 'user', 'users', 'ubuntu', 'admin', 'administrator', 'node', 'build', 'builder', 'ci', 'github', 'circleci', 'jenkins', 'vsts', 'buildkite', 'agent', 'docker', 'vagrant', 'test', 'tester', 'dev', 'developer', 'guest', 'default', 'app', 'www', 'nobody']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ username?: string, env?: Record<string,string|undefined> }} [opts]
 * @returns {RegExp[]}
 */
export function privateTerms({ username = '', env = process.env } = {}) {
  const terms = [/\/Users\/[\w.-]+/, /\/home\/[\w.-]+\//];
  const name = String(username).trim();
  const onCi = Boolean(env.CI) || Boolean(env.GITHUB_ACTIONS);
  if (name.length >= 4 && !onCi && !GENERIC_ACCOUNTS.has(name.toLowerCase())) terms.push(new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`, 'i'));
  for (const t of String(env.LPM_PRIVATE_TERMS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) terms.push(new RegExp(esc(t), 'i'));
  return terms;
}
