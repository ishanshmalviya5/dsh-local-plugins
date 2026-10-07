import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateTerms } from '../scripts/private-terms.mjs';

const hits = (terms, text) => terms.some((re) => re.test(text));

test('home-directory paths are always private', () => {
  const t = privateTerms({ username: 'runner', env: { CI: 'true' } });
  assert.ok(hits(t, 'see /Users/someone/project'));
  assert.ok(hits(t, 'in /home/bob/.config'));
  assert.ok(!hits(t, 'the home directory'));
});

test('a personal account name is flagged as a whole word on a personal machine', () => {
  const t = privateTerms({ username: 'jane-doe42', env: {} });
  assert.ok(hits(t, 'owner jane-doe42 wrote this'));
  assert.ok(!hits(t, 'janedoe42 and jane-doe421 are different words'));
});

test('on CI the (generic) account name is never a private term: "runner" is an everyday word in docs', () => {
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const t = privateTerms({ username: 'runner', env });
    assert.ok(!hits(t, 'the Node test runner and the process runner'));
  }
});

test('generic and very short account names are skipped even off CI', () => {
  for (const username of ['runner', 'root', 'ubuntu', 'admin', 'ci', 'abc', '']) {
    assert.ok(!hits(privateTerms({ username, env: {} }), `the ${username || 'blank'} word root runner ubuntu admin`), username);
  }
});

test('extra terms from LPM_PRIVATE_TERMS are always honoured, on CI too', () => {
  const t = privateTerms({ username: 'runner', env: { CI: 'true', LPM_PRIVATE_TERMS: 'acme-corp, secretproject' } });
  assert.ok(hits(t, 'built for ACME-CORP'));
  assert.ok(hits(t, 'the SecretProject roadmap'));
  assert.ok(!hits(t, 'nothing private here'));
});

test('special characters in a name or term never break the pattern', () => {
  assert.doesNotThrow(() => privateTerms({ username: 'a.b+c(d)', env: { LPM_PRIVATE_TERMS: 'x[y,z*' } }));
});
