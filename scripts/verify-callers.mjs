#!/usr/bin/env node
/**
 * The caller verification gate (R2-1, R2-3).
 * ------------------------------------------
 * A reusable workflow cannot be run locally, so this proves the next best thing:
 * that resolving the shared workflow WITH EACH CALLER'S INPUTS yields the same
 * enabled steps, in the same order, as the file that caller replaced.
 *
 * The originals come from git — `HEAD~1` by default, or $BEFORE_REF — so this
 * keeps working as a regression check across the commit that matters.
 *
 * Usage:
 *
 *   node scripts/verify-callers.mjs <path to the beplus org checkout>
 *     The thirteen library repositories' ci.yml / publish.yml callers of
 *     library-ci.yml / library-publish.yml (R2-1).
 *     e.g. node scripts/verify-callers.mjs ~/Git/github.com/beplus
 *
 *   node scripts/verify-callers.mjs infra-diff --repo <estate checkout> [--ref <ref>]
 *                                   [--caller <file>] [--repository <owner/name>] [--repo …]
 *     Each estate's `.github/workflows/infra-diff.yml` caller of infra-diff.yml
 *     (R2-3, BE-218). `--ref` is the commit whose infra-diff.yml the caller
 *     replaced (default $BEFORE_REF, else HEAD~1). `--caller` checks a caller
 *     that is not committed yet; the manifest is then read at `--ref` too,
 *     otherwise from the checkout. `--repository` defaults to the `origin` remote.
 *     e.g. node scripts/verify-callers.mjs infra-diff \
 *            --repo ~/Git/github.com/bepluscloud/ai --ref origin/dev --caller /tmp/bepluscloud.yml
 *
 * What it CANNOT prove: that the shared workflow runs green on GitHub. That
 * needs setup-beplus pushed and tagged, and one repository taken through a real
 * run. For the libraries do that with beplus/docs before the other eleven; for
 * infra-diff, with one real pull request per estate, bepluscloud first.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = new URL('..', import.meta.url).pathname;

const usage = () => {
  console.error('usage: node scripts/verify-callers.mjs <path to the beplus org checkout>');
  console.error('       node scripts/verify-callers.mjs infra-diff --repo <estate checkout> [--ref <ref>] [--caller <file>] [--repository <owner/name>] [--repo …]');
  process.exit(2);
};

// `yaml` is not a dependency of this repo; borrow the one Rush already installed
// in whichever estate is checked out beside it.
const loadYaml = (roots) => {
  const require_ = createRequire(import.meta.url);
  for (const root of roots) {
    try { return require_(join(root, 'packages', 'aws', 'main', 'node_modules', 'yaml')); } catch { /* try the next */ }
  }
  console.error('no `yaml` module found next to this checkout');
  process.exit(2);
};

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1e8 });

/** JSON with sorted keys: two parsed YAML values are equal iff this is. */
const canon = (value) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v);

// ═════════════════════════════════════════════════════════════════════════════
// R2-1 — the library repositories
// ═════════════════════════════════════════════════════════════════════════════

const libraries = (ORG) => {
  const YAML = loadYaml([
    join(ORG, '..', 'mrkithq', 'monorepo'),
    join(ORG, '..', 'bepluscloud', 'ai'),
  ]);

  const REPOS = ['ai', 'analytics', 'api', 'auth', 'cdk', 'cms', 'data', 'docs', 'mobile', 'saas', 'server', 'web'];

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
      const before = YAML.parse(git(join(ORG, repo), 'show', `${process.env.BEFORE_REF ?? 'HEAD~1'}:${path}`));
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
};

// ═════════════════════════════════════════════════════════════════════════════
// R2-3 — infra-diff.yml in the three estates (BE-218)
// ═════════════════════════════════════════════════════════════════════════════
//
// Stricter than the library check, because there are no inputs to resolve: the
// shared jobs are compared to the replaced file's jobs WHOLE — every job key,
// every step, every `run` / `script` byte — and the only differences allowed
// are the ones declared below, each with its reason. Anything else is divergent.

const WORKFLOW = join('.github', 'workflows', 'infra-diff.yml');
const SHARED_CALL = /^beplus\/setup-beplus\/\.github\/workflows\/infra-diff\.yml@\S+$/;

/**
 * What the shared workflow DERIVES where each copy wrote a literal. Applied to
 * the shared side with the estate's own values; afterwards the text must be the
 * copy's, byte for byte.
 */
const DERIVED = [
  {
    what: 'role ARN: <owner>-<repo> from the calling repository',
    shared: '${{ github.repository_owner }}-${{ github.event.repository.name }}',
    original: (e) => `${e.owner}-${e.name}`,
  },
  {
    what: 'region default: beplus.estate.json defaultRegion',
    shared: '${{ vars.AWS_REGION || needs.plan.outputs.region }}',
    original: (e) => `\${{ vars.AWS_REGION || '${e.region}' }}`,
  },
  {
    what: 'comment marker: beplus.estate.json naming.product, lower-cased',
    shared: '<!-- ${process.env.MARKER}-infra-diff:',
    original: (e) => `<!-- ${e.marker}-infra-diff:`,
  },
];

/** Deliberate behaviour changes, applied to the ORIGINAL side. Reported, never hidden. */
const INTENDED = [
  {
    what: "CLI version: the repository's pin (`be auto`) instead of floating on 2.x — BE-213",
    original: "${{ vars.BE_CLI_VERSION || '2' }}",
    shared: '${{ vars.BE_CLI_VERSION }}',
  },
];

/** What the shared workflow adds — the plumbing for DERIVED — and nothing else. Steps by `id`. */
const ADDED = {
  plan: { outputs: ['region', 'marker'], steps: ['estate'] },
  comment: { stepEnv: { 'uses:actions/github-script@v7': ['MARKER'] } },
};

const stepKey = (step) =>
  step.name ?? (step.uses ? `uses:${step.uses}` : step.id ? `id:${step.id}` : `run:${String(step.run).split('\n')[0]}`);

/** Replace every occurrence in every string inside `value`; count them in `counts[i]`. */
const substitute = (value, pairs, counts) => {
  if (typeof value === 'string') {
    return pairs.reduce((text, [from, to], i) => {
      const parts = text.split(from);
      counts[i] += parts.length - 1;
      return parts.join(to);
    }, value);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, pairs, counts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, pairs, counts)]));
  }
  return value;
};

/** The shared workflow's own guarantees, independent of any caller. */
const sharedSafety = (shared, raw) => {
  const failures = [];
  const triggers = Object.keys(shared.on ?? {});
  if (triggers.join() !== 'workflow_call') failures.push(`triggers are [${triggers}], not just workflow_call`);
  const inputs = Object.keys(shared.on?.workflow_call?.inputs ?? {});
  for (const input of inputs.filter((i) => /mode|role|account|stack|extra|command/i.test(i))) {
    failures.push(`declares the input "${input}" — nothing a caller passes may choose what the diff job does`);
  }
  let composites = 0;
  for (const [jobName, job] of Object.entries(shared.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!/cdk-package/.test(String(step.uses ?? ''))) continue;
      composites += 1;
      if (step.with?.mode !== 'diff') failures.push(`job "${jobName}" runs cdk-package in mode "${step.with?.mode}"`);
      if (!/-cdk-diff$/.test(String(step.with?.['role-arn'] ?? ''))) {
        failures.push(`job "${jobName}" assumes "${step.with?.['role-arn']}", not a …-cdk-diff role`);
      }
      for (const [key, value] of Object.entries(step.with ?? {})) {
        if (/\binputs\./.test(String(value))) failures.push(`job "${jobName}": cdk-package \`${key}\` reads a caller input`);
      }
    }
  }
  if (composites === 0) failures.push('no job runs cdk-package');
  if (/role\/github-actions-[^\s]*-cdk-deploy/.test(raw)) failures.push('names a cdk-deploy role');
  return failures;
};

const parseInfraDiffArgs = (argv) => {
  const entries = [];
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) usage();
    if (flag === '--repo') { entries.push({ dir: resolve(value) }); continue; }
    const current = entries.at(-1);
    if (!current) usage();
    if (flag === '--ref') current.ref = value;
    else if (flag === '--caller') current.caller = resolve(value);
    else if (flag === '--repository') current.repository = value;
    else usage();
  }
  if (entries.length === 0) usage();
  return entries;
};

const repositoryOf = (dir) => {
  const url = git(dir, 'remote', 'get-url', 'origin').trim();
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot read owner/name from the origin remote of ${dir}: ${url}`);
  return `${match[1]}/${match[2]}`;
};

/** The manifest the shared workflow will read: the same file, in the same order, as its step. */
const manifestOf = (dir, ref) => {
  for (const path of ['beplus.estate.json', join('.github', 'actions', 'cdk-package', 'packages.json')]) {
    try {
      return { path, json: JSON.parse(ref ? git(dir, 'show', `${ref}:${path}`) : readFileSync(join(dir, path), 'utf8')) };
    } catch { /* try the next */ }
  }
  throw new Error(`no estate manifest in ${dir}${ref ? ` at ${ref}` : ''}`);
};

const infraDiff = (argv) => {
  const entries = parseInfraDiffArgs(argv);
  const YAML = loadYaml([
    ...entries.map((e) => e.dir),
    join(HERE, '..', '..', 'mrkithq', 'monorepo'),
    join(HERE, '..', '..', 'bepluscloud', 'ai'),
  ]);

  const sharedRaw = readFileSync(join(HERE, WORKFLOW), 'utf8');
  const shared = YAML.parse(sharedRaw);
  let divergent = 0;
  const totals = { identical: 0, derived: 0, intended: 0, added: 0, divergent: 0 };

  console.log('infra-diff.yml (shared)');
  const safety = sharedSafety(shared, sharedRaw);
  for (const failure of safety) console.log(`  ✗ ${failure}`);
  if (safety.length === 0) {
    console.log('  ✓ workflow_call only; cdk-package always `mode: diff` as a …-cdk-diff role; no input reaches it');
  }
  divergent += safety.length;
  const declaredInputs = Object.keys(shared.on?.workflow_call?.inputs ?? {});

  for (const entry of entries) {
    const ref = entry.ref ?? process.env.BEFORE_REF ?? 'HEAD~1';
    const callerPath = entry.caller ?? join(entry.dir, WORKFLOW);
    const repository = entry.repository ?? repositoryOf(entry.dir);
    const [owner, name] = repository.split('/');
    // A caller that is not committed yet runs against the tree its original came from.
    const manifest = manifestOf(entry.dir, entry.caller ? ref : undefined);
    const estate = {
      owner,
      name,
      region: manifest.json.defaultRegion ?? 'us-east-1',
      // Mirrors the workflow's step: lower-case, anything outside [a-z0-9._-] → '-'.
      marker: String(manifest.json.naming?.product || name).toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    };

    const original = YAML.parse(git(entry.dir, 'show', `${ref}:${WORKFLOW}`));
    const caller = YAML.parse(readFileSync(callerPath, 'utf8'));
    const problems = [];
    const counts = { identical: 0, derived: 0, intended: 0, added: 0, divergent: 0 };

    console.log();
    console.log(`${repository}`);
    console.log(`  replaces ${WORKFLOW} at ${ref}; caller ${callerPath}`);
    console.log(`  derives  role github-actions-${owner}-${name}-<env>-cdk-diff · region ${estate.region} · marker <!-- ${estate.marker}-infra-diff:<pkg> -->  (${manifest.path})`);

    // ── The caller: what stays in the repository, exactly as it was ──────────
    const KEPT = ['name', 'on', 'permissions', 'concurrency'];
    for (const key of Object.keys(caller)) {
      if (![...KEPT, 'jobs'].includes(key)) problems.push(`caller: top-level \`${key}\` — nothing but ${KEPT.join(', ')} and the call belongs here`);
    }
    for (const key of Object.keys(original)) {
      if (![...KEPT, 'jobs'].includes(key)) problems.push(`original: top-level \`${key}\` has no home in caller or shared workflow`);
    }
    for (const key of KEPT) {
      if (canon(caller[key]) !== canon(original[key])) {
        problems.push(`caller: \`${key}\` differs from the original\n        had:  ${canon(original[key])}\n        gets: ${canon(caller[key])}`);
      }
    }
    // The jobs run with what the original granted; a called workflow can only narrow it.
    if (canon(shared.permissions) !== canon(original.permissions)) {
      problems.push(`shared: permissions ${canon(shared.permissions)} ≠ the original's ${canon(original.permissions)}`);
    }
    const callerJobs = Object.entries(caller.jobs ?? {});
    if (callerJobs.length !== 1) problems.push(`caller: ${callerJobs.length} jobs — exactly one, the call, belongs here`);
    for (const [jobName, job] of callerJobs) {
      if (!SHARED_CALL.test(String(job.uses ?? ''))) problems.push(`caller: job "${jobName}" does not call beplus/setup-beplus/.github/workflows/infra-diff.yml`);
      for (const key of Object.keys(job.with ?? {})) {
        if (!declaredInputs.includes(key)) problems.push(`caller: job "${jobName}" passes \`${key}\`, which the shared workflow does not declare — GitHub refuses the run`);
      }
      if (job.secrets !== 'inherit' && job.secrets !== undefined) problems.push(`caller: job "${jobName}" passes secrets explicitly — use \`secrets: inherit\``);
      for (const key of Object.keys(job)) {
        if (!['uses', 'with', 'secrets', 'name'].includes(key)) problems.push(`caller: job "${jobName}" sets \`${key}\` — the shared jobs own it`);
      }
    }
    if (problems.length === 0) {
      console.log(`  ✓ caller  ${KEPT.join(', ')} identical to the original; one job, ${callerJobs[0][1].uses}, secrets: ${callerJobs[0][1].secrets}`);
    }

    // ── The jobs: the shared workflow, resolved for this estate, vs the copy ─
    const derivedPairs = DERIVED.map((d) => [d.shared, d.original(estate)]);
    const intendedPairs = INTENDED.map((d) => [d.original, d.shared]);
    const derivedHits = DERIVED.map(() => 0);
    const intendedHits = INTENDED.map(() => 0);

    const sharedJobs = Object.keys(shared.jobs ?? {});
    const originalJobs = Object.keys(original.jobs ?? {});
    if (canon(sharedJobs) !== canon(originalJobs)) {
      problems.push(`jobs: the shared workflow has [${sharedJobs}], the original had [${originalJobs}]`);
    }

    for (const jobName of originalJobs.filter((j) => sharedJobs.includes(j))) {
      const added = ADDED[jobName] ?? {};
      const { steps: sharedSteps = [], ...sharedJob } = shared.jobs[jobName];
      const { steps: originalSteps = [], ...originalJob } = original.jobs[jobName];

      // Job keys.
      const resolvedJob = substitute(sharedJob, derivedPairs, derivedHits);
      for (const output of added.outputs ?? []) {
        if (resolvedJob.outputs?.[output] === undefined) problems.push(`job "${jobName}": declared added output "${output}" is gone`);
        else delete resolvedJob.outputs[output];
      }
      if (canon(resolvedJob) !== canon(substitute(originalJob, intendedPairs, intendedHits))) {
        problems.push(`job "${jobName}": job keys differ\n        had:  ${canon(originalJob)}\n        gets: ${canon(resolvedJob)}`);
      }
      const extra = (added.outputs ?? []).length ? `  (+ outputs ${added.outputs.join(', ')})` : '';
      console.log(`  job ${jobName}${extra}`);

      // Steps, in order. A declared added step is reported where it sits and
      // skipped; every other shared step is paired with the original's next one.
      const isAdded = (s) => (added.steps ?? []).includes(s.id);
      for (const key of added.steps ?? []) {
        if (!sharedSteps.some((s) => s.id === key)) problems.push(`job "${jobName}": declared added step "${key}" is gone`);
      }
      const pairs = [];
      let next = 0;
      for (const step of sharedSteps) {
        if (isAdded(step)) pairs.push([step, null, true]);
        else pairs.push([step, originalSteps[next++], false]);
      }
      for (; next < originalSteps.length; next += 1) pairs.push([undefined, originalSteps[next], false]);
      for (const [i, [mine, theirs, isNew]] of pairs.entries()) {
        const label = stepKey(mine ?? theirs).padEnd(58);
        if (isNew) {
          counts.added += 1;
          console.log(`    + ${label} added — reads the derived values from the manifest`);
          continue;
        }
        if (!mine || !theirs) {
          counts.divergent += 1;
          problems.push(`job "${jobName}" step ${i + 1}: ${mine ? 'only in the shared workflow' : 'missing from the shared workflow'} — ${stepKey(mine ?? theirs)}`);
          console.log(`    ✗ ${label} ${mine ? 'only in the shared workflow' : 'MISSING from the shared workflow'}`);
          continue;
        }
        if (canon(mine) === canon(theirs)) {
          counts.identical += 1;
          console.log(`    ✓ ${label} identical`);
          continue;
        }
        const dHits = DERIVED.map(() => 0);
        const iHits = INTENDED.map(() => 0);
        const resolved = substitute(mine, derivedPairs, dHits);
        for (const envKey of added.stepEnv?.[stepKey(mine)] ?? []) {
          if (resolved.env?.[envKey] === undefined) problems.push(`job "${jobName}": declared added env ${envKey} is gone`);
          else delete resolved.env[envKey];
        }
        const target = substitute(theirs, intendedPairs, iHits);
        dHits.forEach((n, j) => { derivedHits[j] += n; });
        iHits.forEach((n, j) => { intendedHits[j] += n; });
        if (canon(resolved) === canon(target)) {
          const why = [
            ...DERIVED.filter((_, j) => dHits[j]).map((d) => d.what),
            ...INTENDED.filter((_, j) => iHits[j]).map((d) => `intended: ${d.what}`),
          ];
          if (iHits.some(Boolean)) counts.intended += 1; else counts.derived += 1;
          console.log(`    ${iHits.some(Boolean) ? '~' : '✓'} ${label} ${why.join('; ')}`);
        } else {
          counts.divergent += 1;
          problems.push(`job "${jobName}" step ${i + 1} "${stepKey(mine)}" differs\n        had:  ${canon(target)}\n        gets: ${canon(resolved)}`);
          console.log(`    ✗ ${label} DIVERGENT`);
        }
      }
    }

    // A declared difference that never applied means the shared workflow moved
    // and this list did not — the proof would be checking a file that no longer exists.
    DERIVED.forEach((d, j) => { if (!derivedHits[j]) problems.push(`declared derivation never applied: ${d.what}`); });

    for (const problem of problems) console.log(`  ✗ ${problem}`);
    const steps = counts.identical + counts.derived + counts.intended + counts.added + counts.divergent;
    console.log(`  ${steps} steps: ${counts.identical} identical, ${counts.derived} identical once derived, ` +
      `${counts.intended} intended (BE-213 pin), ${counts.added} added, ${counts.divergent} divergent` +
      `${problems.length ? ` — ${problems.length} problem(s)` : ''}`);
    divergent += problems.length;
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }

  console.log();
  console.log(`  ${entries.length} estate(s): ${totals.identical} identical, ${totals.derived} identical once derived, ` +
    `${totals.intended} intended, ${totals.added} added, ${totals.divergent} divergent step(s)`);
  console.log(divergent === 0
    ? `  every caller + infra-diff.yml reproduces the workflow it replaces`
    : `  ${divergent} problem(s): a caller would not do what its workflow did before`);
  process.exit(divergent === 0 ? 0 : 1);
};

// ─────────────────────────────────────────────────────────────────────────────
const [first, ...rest] = process.argv.slice(2);
if (!first) usage();
if (first === 'infra-diff') infraDiff(rest);
else if (existsSync(first)) libraries(first);
else usage();
