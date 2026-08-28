# Working on Ruby Health

## Branching

`master` is the trunk. It should always hold a commit that could be deployed.

Work happens on a branch off `master` and comes back through a pull request:

```
git checkout master
git pull origin master
git checkout -b <short-description>
# ...work, commit...
git push -u origin <short-description>
# open a PR into master
```

Nothing is pushed directly to `master`. CI runs the backend test suite and a
boot check on every pull request; a red suite means the branch is not ready,
not that the check is inconvenient.

## Deploys

**Right now (prototype):** the Render service auto-deploys on commit. That is
appropriate here — the worst case is a broken demo link — and it is explicitly
*not* the arrangement the production system should have.

**Before real patient data is involved**, the following stop being optional:

- Branch protection on `master`, with CI required to pass before a merge.
- The accuracy evaluation suite gating deploys alongside the unit tests, so a
  change that quietly degrades coding accuracy cannot ship.
- A staging environment that receives the deploy first, with promotion to
  production as a separate deliberate step.
- Tagged releases and a rehearsed rollback, so "go back to the last good
  version" is one action rather than an improvisation.
- Deploy records tying a running version to its commit and to whoever approved
  it. Once PHI is in scope this is an audit requirement, not hygiene.

## Tests

```
cd backend
npm test            # unit tests: claim assembly, pointer linkage, quote grounding
```

The browser smoke test needs a running server and Playwright available on the
machine (it is deliberately not a project dependency):

```
cd backend && PORT=3115 node src/server.js &
node test/ui-smoke.mjs
```

It checks what unit tests cannot — that a grounding verdict reaches the screen,
that an edited quote drops its stale verdict, and that claim warnings surface
above the form rather than being buried in it.

## A standing rule about this codebase

No real patient data, ever, until the compliance phase is genuinely done. This
build has no encryption at rest, no audit logging, no retention policy, and no
signed BAA. Synthetic encounters only.
