// Keep secrets out of logs, error messages, the UI and notices.
// Applied to every line a child process prints, every operation error, and every
// URL shown to the user. Conservative on purpose: when in doubt, mask.
const RULES = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],                                   // scheme://user:token@host
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '***'],                // GitHub tokens
  [/\bnpm_[A-Za-z0-9]{20,}/g, '***'],                                                    // npm tokens
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '***'],                                                   // API keys (sk-…)
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],                                                       // AWS access key ids
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],                              // auth headers
  [/(_authToken|_auth|_password)(\s*=\s*)\S+/gi, '$1$2***'],                              // .npmrc
  [/\b((?:access[_-]?|auth[_-]?|api[_-]?|refresh[_-]?|secret[_-]?)?(?:token|secret|password|passwd|apikey|authorization))(["']?\s*[:=]\s*["']?)([^\s"',;&]{3,})/gi, '$1$2***'],
];

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}

/** A URL safe to display: credentials removed. Non-URLs pass through redact(). */
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return redact(url);
}
