#!/usr/bin/env node
/**
 * The R2-1 verification gate.
 * ---------------------------
 * A reusable workflow cannot be run locally, so this proves the next best thing:
 * that resolving the shared workflow WITH EACH CALLER'S INPUTS yields the same
 * enabled steps, in the same order, as the file that caller replaced.
 *
 * The originals come from git (HEAD~1), so this keeps working as a regression
 * check for exactly one commit — which is the commit that matters.
 *
 * Usage:  node scripts/verify-callers.mjs <path to the beplus org checkout>
 *         e.g. node scripts/verify-callers.mjs ~/Git/github.com/beplus
 *
 * What it CANNOT prove: that the shared workflow runs green on GitHub. That
 * needs setup-beplus pushed and tagged, and one repository taken through a real
 * publish. Do that with beplus/docs before the other eleven.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORG = process.argv[2];
if (!ORG) {
  console.error('usage: node scripts/verify-callers.mjs <path to the beplus org checkout>');
  process.exit(2);
}

// `yaml` is not a dependency of this repo; borrow the one Rush already installed
// in whichever estate is checked out beside it.
const require_ = createRequire(import.meta.url);
let YAML;
for (const candidate of [
  join(ORG, '..', 'mrkithq', 'monorepo', 'packages', 'aws', 'main', 'node_modules', 'yaml'),
  join(ORG, '..', 'bepluscloud', 'ai', 'packages', 'aws', 'main', 'node_modules', 'yaml'),
]) {
  try { YAML = require_(candidate); break; } catch { /* try the next */ }
}
if (!YAML) { console.error('no `yaml` module found next to this checkout'); process.exit(2); }

const REPOS = ['ai', 'analytics', 'api', 'auth', 'cdk', 'cms', 'data', 'docs', 'mobile', 'saas', 'server', 'web'];
const HERE = new URL('..', import.meta.url).pathname;

const shared = Object.fromEntries(
  ['library-ci', 'library-publish'].map((n) => [
    n, YAML.parse(readFileSync(join(HERE, '.github', 'workflows', `${n}.yml`), 'utf8')),
  ]),
);

/**
 * The steps a caller's inputs actually enable, in order.
 *
 * ⚠️ EVERY `inputs.x` IN THE CONDITION COUNTS, not just the first. The gates are
 * compound — `inputs.force && inputs.force-change-files` — and reading only the
 * leading one reported six repositories as gaining a step that is in fact
 * skipped. A step is enabled unless SOME input it names is literally `false`;
 * anything else leaves it in, with its own runtime condition intact.
 */
const enabledSteps = (workflow, withInputs) => {
  const job = Object.values(workflow.jobs)[0];
  return job.steps
    .filter((step) => {
      const named = [...String(step.if ?? '').matchAll(/inputs\.([a-z-]+)/g)].map((m) => m[1]);
      return !named.some((name) => withInputs[name] === false);
    })
    .map((step) => step.name ?? `uses:${step.uses}`);
};

let failures = 0;
for (const repo of REPOS) {
  for (const [file, workflow] of [['ci', 'library-ci'], ['publish', 'library-publish']]) {
    const path = `.github/workflows/${file}.yml`;
    const before = YAML.parse(
      execFileSync('git', ['-C', join(ORG, repo), 'show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 1e8 }),
    );
    const caller = YAML.parse(readFileSync(join(ORG, repo, path), 'utf8'));

    const wanted = Object.values(before.jobs)[0].steps.map((s) => s.name ?? `uses:${s.uses}`);
    const got = enabledSteps(shared[workflow], Object.values(caller.jobs)[0].with ?? {});

    if (JSON.stringify(wanted) === JSON.stringify(got)) {
      console.log(`  ✓ ${repo}/${file}  ${got.length} steps`);
    } else {
      failures += 1;
      console.log(`  ✗ ${repo}/${file}`);
      console.log(`      had:  ${wanted.join(' | ')}`);
      console.log(`      gets: ${got.join(' | ')}`);
    }
  }
}
console.log();
console.log(failures === 0
  ? `  all ${REPOS.length * 2} workflows resolve to the steps they replace`
  : `  ${failures} workflow(s) would not do what they did before`);
process.exit(failures === 0 ? 0 : 1);
