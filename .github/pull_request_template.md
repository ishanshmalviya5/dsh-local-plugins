## What and why
<!-- What does this change, and why? Link the issue. Keep the PR to one concern. -->

## How it was verified
<!-- Paste REAL output. Say what you did not test. -->
- [ ] `npm run check` passes (paste the summary lines)
- [ ] `npm run test:e2e` passes, or not applicable because: 
- [ ] New behaviour has a test; a bug fix has a test that failed before the fix

## Risk and rollback
<!-- What could go wrong for a user's dsh install? How do they undo it? Does it touch deploy, recovery, registry, or script permission? -->

## Safety checklist
- [ ] No weakened invariant (commit-only, atomic switch, crash recovery, nothing destroyed, untrusted input, script permission) — or justified above with a pinning test
- [ ] No secrets, tokens, e-mails, home paths or private names (`npm run check:package` clean)
- [ ] User-facing errors say what happened, whether the current setup is safe, and what to do next
- [ ] Docs / CHANGELOG updated if behaviour changed

## AI assistance
- [ ] No AI-written code in this PR
- [ ] AI-assisted: tool / model: ________ — I read and understand every change, ran the checks myself, and verified the claims above
