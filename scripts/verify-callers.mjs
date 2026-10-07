#!/usr/bin/env node
/**
 * The caller verification gate (R2-1, R2-3, R2-4).
 * -------------------------------------------------
 * A reusable workflow cannot be run locally, so this proves the next best thing:
 * that resolving the shared workflow WITH EACH CALLER'S INPUTS yields the same
 * enabled steps, in the same order, as the file that caller replaced.
 *
 * The originals come from git — $BEFORE_REF, else (libraries) the parent of the
 * commit that made each file a caller, else `HEAD~1` — so this keeps working as a
 * regression check across the commit that matters.
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
 *   node scripts/verify-callers.mjs db --repo <estate checkout> [--ref <ref>] [--callers <dir>]
 *                                   [--manifest <file>] [--repository <owner/name>] [--repo …]
 *     Each estate's `.github/workflows/db-migrations-pr.yml` and `db-drift-env.yml`
 *     callers of the shared workflows of the same names (R2-4, BE-232). `--ref`
 *     is the commit whose copies the callers replaced (default $BEFORE_REF, else
 *     HEAD~1); a repository with no copy there (bepluscloud) GAINS the workflow,
 *     and only its caller and the manifest's derivation are checked. `--callers`
 *     is a directory holding callers not committed yet; the manifest and the
 *     database package are then read at `--ref` too, otherwise from the
 *     checkout. `--manifest` replaces beplus.estate.json (a section an adoption
 *     will add). Needs bash ≥ 4 and jq: the shared plan step and the rewritten
 *     guard / drift steps are RUN, side by side with the copies' steps.
 *     e.g. node scripts/verify-callers.mjs db \
 *            --repo ~/Git/github.com/ironmountain-cz/monorepo --ref origin/dev --callers /tmp/db-callers/mountaineer
 *
 * What it CANNOT prove: that the shared workflow runs green on GitHub. That
 * needs setup-beplus pushed and tagged, and one repository taken through a real
 * run. For the libraries do that with beplus/docs before the other eleven; for
 * infra-diff and the db workflows, with one real pull request (one manual drift
 * run) per estate, bepluscloud first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const HERE = new URL('..', import.meta.url).pathname;

const usage = () => {
  console.error('usage: node scripts/verify-callers.mjs <path to the beplus org checkout>');
  console.error('       node scripts/verify-callers.mjs infra-diff --repo <estate checkout> [--ref <ref>] [--caller <file>] [--repository <owner/name>] [--repo …]');
  console.error('       node scripts/verify-callers.mjs db --repo <estate checkout> [--ref <ref>] [--callers <dir>] [--manifest <file>] [--repository <owner/name>] [--repo …]');
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

  /**
   * The commit whose file the caller replaced. `HEAD~1` was right only on the day
   * each caller landed; every later commit made it compare a caller with a caller
   * (and crash on its missing `steps`). So, unless $BEFORE_REF says otherwise: the
   * parent of the oldest commit that wrote the `uses:` line in.
   */
  const beforeRef = (dir, path, workflow) => {
    if (process.env.BEFORE_REF) return process.env.BEFORE_REF;
    const introduced = git(dir, 'log', '--format=%H', '-S', `setup-beplus/.github/workflows/${workflow}.yml`, '--', path)
      .trim().split('\n').filter(Boolean).at(-1);
    return introduced ? `${introduced}~1` : 'HEAD~1';
  };

  let failures = 0;
  for (const repo of REPOS) {
    for (const [file, workflow] of [['ci', 'library-ci'], ['publish', 'library-publish']]) {
      const path = `.github/workflows/${file}.yml`;
      const ref = beforeRef(join(ORG, repo), path, workflow);
      const before = YAML.parse(git(join(ORG, repo), 'show', `${ref}:${path}`));
      const caller = YAML.parse(readFileSync(join(ORG, repo, path), 'utf8'));

      const beforeSteps = Object.values(before.jobs)[0].steps;
      if (!Array.isArray(beforeSteps)) {
        failures += 1;
        console.log(`  ✗ ${repo}/${file}  at ${ref} it is already a caller — set BEFORE_REF to the commit before the switch`);
        continue;
      }
      const wanted = beforeSteps.map((s) => s.name ?? `uses:${s.uses}`);
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

// ═════════════════════════════════════════════════════════════════════════════
// R2-4 — db-migrations-pr.yml and db-drift-env.yml in the estates (BE-232)
// ═════════════════════════════════════════════════════════════════════════════
//
// The infra-diff method — the shared jobs, resolved for an estate, against the
// copy's jobs, whole: every job key, every step, every byte — with two additions:
//
//   1. The values the shared workflow derives are not re-implemented here. Its
//      `plan` step is RUN, on the estate's own beplus.estate.json and database
//      package.json, and its outputs are what `${{ needs.plan.outputs.* }}`
//      resolves to. A derivation that is wrong for an estate shows up as a job or
//      step that no longer matches the copy.
//   2. Where a step body became a loop over the manifest's environments (the
//      drift job's guard and comparison), text cannot match. Those steps are run
//      side by side with the copy's — stub `npm` / `beplus`, every scenario that
//      changes their output — and must print the same and exit the same.
//
// Every other difference is declared below with its reason, and reported; an
// undeclared one is divergent.

const DB_WORKFLOWS = ['db-migrations-pr', 'db-drift-env'];
const CLI_ACTION = /^beplus\/setup-beplus\/cli@/;
const AUTH_STEP = 'Authenticate the @beplus scope';
const PINNED_CLI = '${{ vars.BE_CLI_VERSION }}';
const TOOLS_DUMP_IMAGE = 'pgvector/pgvector:pg16';
const PINNED_SERVER = 'pgvector/pgvector:0.8.7-pg16';

/** Rewrites of the COPY's step: what the shared workflow does differently on purpose. `null`: not this step. */
const COMMON_STEP_INTENDED = [
  {
    what: "CLI: the repository's pin (`be auto`), not `vars.BE_CLI_VERSION || '2'` / `latest` — BE-213",
    apply: (s) => CLI_ACTION.test(s.uses ?? '') && ["${{ vars.BE_CLI_VERSION || '2' }}", 'latest'].includes(s.with?.BE_CLI_VERSION)
      ? { ...s, with: { ...s.with, BE_CLI_VERSION: PINNED_CLI } } : null,
  },
  {
    what: `named "${AUTH_STEP}", as MRKIT's copy names it`,
    apply: (s) => CLI_ACTION.test(s.uses ?? '') && s.name === undefined ? { ...s, name: AUTH_STEP } : null,
  },
];

/** Additions on the SHARED side, stripped before comparing. `null`: not there. */
const COMMON_STEP_ADDED = [
  {
    what: 'BE_NPM_CHECK: the stub-200 registry check (the @beplus packages the database package needs come back as real packages)',
    strip: (s) => {
      if (!CLI_ACTION.test(s.uses ?? '') || s.with?.BE_NPM_CHECK === undefined) return null;
      const { BE_NPM_CHECK: _check, ...rest } = s.with;
      return { ...s, with: rest };
    },
  },
];

const runRewrite = (from, to, what) => ({ what, apply: (s) => (s.run === from ? { ...s, run: to } : null) });

const DB = {
  'db-migrations-pr': {
    jobs: { checks: 'checks' },
    jobIntended: [
      {
        what: `Postgres service ${PINNED_SERVER}, not the floating pg16 tag — a rebuild's server cannot change under a pull request`,
        apply: (j) => (j.services?.postgres?.image === TOOLS_DUMP_IMAGE
          ? { ...j, services: { ...j.services, postgres: { ...j.services.postgres, image: PINNED_SERVER } } } : null),
      },
      {
        what: `BE_PGDUMP_IMAGE unset: the repository's database.dumpImage, else @beplus/database-tools' pin — ${TOOLS_DUMP_IMAGE}, this value`,
        apply: (j) => (j.env?.BE_PGDUMP_IMAGE === TOOLS_DUMP_IMAGE
          ? { ...j, env: Object.fromEntries(Object.entries(j.env).filter(([k]) => k !== 'BE_PGDUMP_IMAGE')) } : null),
      },
    ],
    stepIntended: [
      ...COMMON_STEP_INTENDED,
      runRewrite('npm run db:check:collisions', 'beplus db check', 'the npm script\'s own command — `db:check:collisions` was `beplus db check`'),
      runRewrite('npm run db:check:pending', 'beplus db check pending', '`beplus db check pending` — @beplus/database-tools, the copies\' bin/db-check-pending.ts (BE-228; parity BE-231)'),
      runRewrite('npm run db:check:rebuild -- --compare', 'beplus db check rebuild --compare', '`beplus db check rebuild --compare` — @beplus/database-tools, the copies\' bin/db-check-rebuild.ts (BE-228; parity BE-231)'),
      {
        what: '`beplus db check chains` — every chain the declaration embeds, the copy\'s bin/db-check-ai-chain.ts among them (BE-228)',
        apply: (s) => (s.run === 'npm run db:check:ai-chain'
          ? { ...s, name: 'Embedded migration chains check', run: 'beplus db check chains' } : null),
      },
    ],
    stepAdded: COMMON_STEP_ADDED,
    addedIfAbsent: {
      chains: {
        why: 'the declaration\'s chains, which this copy never checked in CI (MRKIT: beplus_ai + analytics, only in its local `db:check`)',
        present: (s) => /^npm run db:check:[a-z]+-chain$/.test(String(s.run ?? '')),
      },
    },
    removedIfPresent: [],
    behaviour: {},
  },
  'db-drift-env': {
    jobs: { drift: 'drift' },
    jobIntended: [
      {
        what: `BE_PGDUMP_IMAGE unset: the repository's database.dumpImage, else @beplus/database-tools' pin — ${TOOLS_DUMP_IMAGE}, this value`,
        apply: (j) => (j.env?.BE_PGDUMP_IMAGE === TOOLS_DUMP_IMAGE
          ? { ...j, env: Object.fromEntries(Object.entries(j.env).filter(([k]) => k !== 'BE_PGDUMP_IMAGE')) } : null),
      },
    ],
    jobAdded: [
      {
        what: 'BE_POSTGRES_URL_STAGE mapped: the stage leg of an estate that lists stage (MRKIT, bepluscloud)',
        strip: (j) => (j.env?.BE_POSTGRES_URL_STAGE === '${{ secrets.BE_POSTGRES_URL_STAGE }}'
          ? { ...j, env: Object.fromEntries(Object.entries(j.env).filter(([k]) => k !== 'BE_POSTGRES_URL_STAGE')) } : null),
      },
    ],
    stepIntended: COMMON_STEP_INTENDED,
    stepAdded: COMMON_STEP_ADDED,
    addedIfAbsent: {},
    removedIfPresent: [
      {
        what: 'no build: `beplus db diff` reads the committed schema file and the databases, no compiled schema (Mountaineer\'s copy never built)',
        match: (s) => s.name === 'Rush build' && /^node common\/scripts\/install-run-rush\.js build --to \S+$/.test(String(s.run ?? '')),
      },
    ],
    // Steps whose body became a loop over the environments: run side by side.
    behaviour: {
      guard: { added: ['ENVIRONMENTS'], scenarios: 'guard' },
      drift: { added: ['ENVIRONMENTS', 'SUMMARY'], scenarios: 'drift' },
    },
  },
};

/** What the shared workflow may do at all, whoever calls it. */
const dbSafety = (name, shared, raw) => {
  const failures = [];
  const triggers = Object.keys(shared.on ?? {});
  if (triggers.join() !== 'workflow_call') failures.push(`triggers are [${triggers}], not just workflow_call`);
  if (canon(shared.permissions) !== canon({ contents: 'read' })) failures.push(`permissions ${canon(shared.permissions)} — contents: read is all it needs`);
  for (const [jobName, job] of Object.entries(shared.jobs ?? {})) {
    if (job.permissions !== undefined) failures.push(`job "${jobName}" sets its own permissions`);
    for (const step of job.steps ?? []) {
      if (/configure-aws-credentials/.test(String(step.uses ?? ''))) failures.push(`job "${jobName}" assumes an AWS role`);
    }
  }
  const secrets = [...new Set([...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  const allowed = name === 'db-migrations-pr'
    ? ['BE_NPM_TOKEN']
    : ['BE_NPM_TOKEN', 'BE_POSTGRES_URL_DEV', 'BE_POSTGRES_URL_STAGE', 'BE_POSTGRES_URL_PROD'];
  for (const secret of secrets.filter((x) => !allowed.includes(x))) failures.push(`reads secrets.${secret}`);
  // What runs, not what the comments say about other commands.
  const code = raw.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const commands = [...code.matchAll(/\bbeplus\s+db\s+([a-z-]+(?:\s+[a-z-]+)?)/g)].map((m) => m[1]);
  for (const command of commands) {
    const ok = name === 'db-migrations-pr' ? /^check(\s|$)/.test(command) : /^diff(\s|$)/.test(command);
    if (!ok) failures.push(`runs \`beplus db ${command}\` — ${name === 'db-migrations-pr' ? 'only `db check …`' : 'only `db diff`'} belongs here`);
  }
  if (/--write\b/.test(code)) failures.push('writes a schema file (--write)');
  if (name === 'db-migrations-pr') {
    const url = String(shared.jobs?.checks?.env?.BE_POSTGRES_URL ?? '');
    if (!/^postgres:\/\/[^@]+@localhost:5432\//.test(url)) failures.push(`BE_POSTGRES_URL is "${url}", not the job's own localhost service`);
  }
  return failures;
};

const parseDbArgs = (argv) => {
  const entries = [];
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) usage();
    if (flag === '--repo') { entries.push({ dir: resolve(value) }); continue; }
    const current = entries.at(-1);
    if (!current) usage();
    if (flag === '--ref') current.ref = value;
    else if (flag === '--callers') current.callers = resolve(value);
    else if (flag === '--manifest') current.manifest = resolve(value);
    else if (flag === '--repository') current.repository = value;
    else usage();
  }
  if (entries.length === 0) usage();
  return entries;
};

/** A file at `ref` (or in the checkout when `ref` is undefined); undefined when it is not there. */
const readAt = (dir, ref, path) => {
  try {
    return ref
      ? execFileSync('git', ['-C', dir, 'show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'ignore'] })
      : readFileSync(join(dir, path), 'utf8');
  } catch {
    return undefined;
  }
};

/** Replace `${{ needs.plan.outputs.x }}` and `${{ inputs.x }}` in every string; collect what was used. */
const EXPRESSION = /\$\{\{\s*(needs\.plan\.outputs|inputs)\.([A-Za-z0-9_-]+)\s*\}\}/g;
const resolveExpressions = (value, scope, used) => {
  if (typeof value === 'string') {
    return value.replace(EXPRESSION, (whole, where, key) => {
      const table = where === 'inputs' ? scope.inputs : scope.outputs;
      if (!Object.hasOwn(table, key)) { used.unknown.add(whole); return whole; }
      used.keys.add(`${where === 'inputs' ? 'inputs' : 'plan'}.${key}`);
      return table[key];
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveExpressions(v, scope, used));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveExpressions(v, scope, used)]));
  }
  return value;
};

const bashOk = () => {
  const r = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' });
  return Number(r.stdout.trim()) >= 4 && spawnSync('jq', ['--version']).status === 0;
};

/** Run a `run:` body as GitHub does when no shell is given (`bash -e {0}`). */
const runBody = (body, { cwd, env }) => {
  const file = join(cwd, `.step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, body);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', file], { cwd, env, encoding: 'utf8' });
  rmSync(file, { force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/**
 * The shared workflow's `plan` step, run as GitHub would run it on the estate's tree:
 * beplus.estate.json and the database package's package.json in a scratch directory.
 */
const runPlan = (shared, inputs, files, repository) => {
  const plan = shared.jobs?.plan;
  const step = plan?.steps?.find((s) => s.id === 'database');
  if (!step) return { error: 'the shared workflow has no plan job with a `database` step' };
  const sandbox = mkdtempSync(join(tmpdir(), 'verify-callers-plan-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(sandbox, path)), { recursive: true });
      writeFileSync(join(sandbox, path), text);
    }
    const output = join(sandbox, '.github-output');
    writeFileSync(output, '');
    const used = { keys: new Set(), unknown: new Set() };
    const stepEnv = resolveExpressions(step.env ?? {}, { inputs, outputs: {} }, used);
    const r = runBody(step.run, {
      cwd: sandbox,
      env: { PATH: process.env.PATH, HOME: sandbox, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repository, ...stepEnv },
    });
    if (r.status !== 0) return { error: `the plan step failed (exit ${r.status}): ${(r.stdout + r.stderr).trim().split('\n').slice(-2).join(' / ')}` };
    const stepOutputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    const outputs = Object.fromEntries(Object.entries(plan.outputs ?? {}).map(([key, expr]) => {
      const m = String(expr).match(/^\$\{\{\s*steps\.database\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/);
      return [key, m ? stepOutputs[m[1]] ?? '' : String(expr)];
    }));
    return { outputs, log: r.stdout.trim() };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

/** The stubs a rewritten step runs against: the copy's `npm run db:diff -- a b` and the shared `beplus db diff a b`. */
const STUBS = {
  npm: '#!/usr/bin/env bash\nif [ "$1" = run ] && [ "$2" = db:diff ] && [ "$3" = -- ]; then exec "$STUB_DIFF" npm "$4" "$5"; fi\necho "unexpected: npm $*" >&2; exit 97\n',
  beplus: '#!/usr/bin/env bash\nif [ "$1" = db ] && [ "$2" = diff ]; then exec "$STUB_DIFF" beplus "$3" "$4"; fi\necho "unexpected: beplus $*" >&2; exit 97\n',
  // The bins exit 1 on drift; the CLI turns a failed program into exit 2. The aggregation must not care.
  diff: '#!/usr/bin/env bash\necho "[db:diff] $2 vs $3"\necho "[db:diff] (stderr) $2 vs $3" >&2\ncase ",$STUB_FAIL," in *",$2:$3,"*) if [ "$1" = beplus ]; then exit 2; else exit 1; fi ;; esac\nexit 0\n',
};

/** Every scenario that changes what a guard or drift step prints, for these environments. */
const scenarios = (kind, envs) => {
  const url = (env) => `BE_POSTGRES_URL_${env.toUpperCase()}`;
  const all = Object.fromEntries(envs.map((e) => [url(e), `postgres://reader:secret@${e}.example:5432/db`]));
  if (kind === 'guard') {
    return [
      { name: 'every connection string set', env: all },
      ...envs.map((e) => ({ name: `${url(e)} unset`, env: Object.fromEntries(Object.entries(all).filter(([k]) => k !== url(e))) })),
      ...envs.map((e) => ({ name: `${url(e)} empty`, env: { ...all, [url(e)]: '' } })),
      { name: 'none set', env: {} },
    ];
  }
  const pairs = [...envs.map((e) => `migrations:${e}`), ...envs.slice(1).map((e, i) => `${envs[i]}:${e}`)];
  return [
    { name: 'no drift', env: { ...all, STUB_FAIL: '' } },
    ...pairs.map((p) => ({ name: `drift in ${p.replace(':', ' vs ')}`, env: { ...all, STUB_FAIL: p } })),
    { name: 'drift everywhere', env: { ...all, STUB_FAIL: pairs.join(',') } },
  ];
};

/** Run the copy's step and the shared step under each scenario; the transcripts must be equal. */
const behaves = (kind, envs, original, shared, jobEnvOriginal, jobEnvShared) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'verify-callers-steps-'));
  try {
    const bin = join(sandbox, 'bin');
    mkdirSync(bin);
    for (const [name, text] of Object.entries(STUBS)) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const base = { PATH: `${bin}:/usr/bin:/bin:${process.env.PATH}`, HOME: sandbox, STUB_DIFF: join(bin, 'diff') };
    // A job's connection strings come from its `env`; the scenario decides which are set.
    const strip = (env) => Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => !/^BE_POSTGRES_URL_/.test(k)));
    const results = [];
    for (const scenario of scenarios(kind, envs)) {
      const before = runBody(original.run, { cwd: sandbox, env: { ...base, ...strip(jobEnvOriginal), ...(original.env ?? {}), ...scenario.env } });
      const after = runBody(shared.run, { cwd: sandbox, env: { ...base, ...strip(jobEnvShared), ...(shared.env ?? {}), ...scenario.env } });
      const same = before.status === after.status && before.stdout === after.stdout && before.stderr === after.stderr;
      results.push({ scenario: scenario.name, same, before, after });
    }
    return results;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};

const without = (object, keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([k]) => !keys.includes(k)));

/** Apply each declared rewrite that matches; return the result and what applied. */
const rewrite = (value, declarations, key) => {
  const applied = [];
  let current = value;
  for (const d of declarations) {
    const next = d[key](current);
    if (next) { current = next; applied.push(d.what); }
  }
  return { value: current, applied };
};

const databaseWorkflows = (argv) => {
  const entries = parseDbArgs(argv);
  if (!bashOk()) {
    console.error('verify-callers db needs bash ≥ 4 and jq on PATH (GitHub\'s runners have both): it runs the shared plan step and the rewritten steps.');
    process.exit(2);
  }
  const YAML = loadYaml([
    ...entries.map((e) => e.dir),
    join(HERE, '..', '..', 'mrkithq', 'monorepo'),
    join(HERE, '..', '..', 'bepluscloud', 'ai'),
  ]);

  const shared = {};
  const sharedRaw = {};
  let problemsTotal = 0;
  const totals = { identical: 0, derived: 0, intended: 0, added: 0, removed: 0, behaviour: 0, divergent: 0 };

  for (const name of DB_WORKFLOWS) {
    sharedRaw[name] = readFileSync(join(HERE, '.github', 'workflows', `${name}.yml`), 'utf8');
    shared[name] = YAML.parse(sharedRaw[name]);
    console.log(`${name}.yml (shared)`);
    const failures = dbSafety(name, shared[name], sharedRaw[name]);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    if (failures.length === 0) {
      console.log(name === 'db-migrations-pr'
        ? '  ✓ workflow_call only; contents: read; no AWS; BE_NPM_TOKEN its only secret; `beplus db check …` only, against its own localhost service'
        : '  ✓ workflow_call only; contents: read; no AWS; BE_NPM_TOKEN + BE_POSTGRES_URL_DEV/STAGE/PROD its only secrets; `beplus db diff` only, nothing written');
    }
    problemsTotal += failures.length;
  }

  for (const entry of entries) {
    const ref = entry.ref ?? process.env.BEFORE_REF ?? 'HEAD~1';
    const repository = entry.repository ?? repositoryOf(entry.dir);
    // Callers not committed yet run against the tree their originals came from.
    const treeRef = entry.callers ? ref : undefined;
    const manifestText = entry.manifest ? readFileSync(entry.manifest, 'utf8') : readAt(entry.dir, treeRef, 'beplus.estate.json');
    console.log();
    console.log(`${repository}`);
    if (manifestText === undefined) {
      console.log(`  ✗ no beplus.estate.json${treeRef ? ` at ${treeRef}` : ''}`);
      problemsTotal += 1;
      continue;
    }
    const manifest = JSON.parse(manifestText);
    // Which package.json the plan step will look for — the step itself decides, and fails if this guess is wrong.
    const packageDir = manifest.database?.package ?? 'packages/modules/database';
    const packageJson = readAt(entry.dir, treeRef, `${packageDir}/package.json`);
    const files = { 'beplus.estate.json': manifestText, ...(packageJson === undefined ? {} : { [`${packageDir}/package.json`]: packageJson }) };
    console.log(`  manifest ${entry.manifest ?? `beplus.estate.json${treeRef ? ` at ${treeRef}` : ''}`}; copies at ${ref}`);

    for (const name of DB_WORKFLOWS) {
      const decl = DB[name];
      const path = join('.github', 'workflows', `${name}.yml`);
      const callerPath = entry.callers ? join(entry.callers, `${name}.yml`) : join(entry.dir, path);
      const originalText = readAt(entry.dir, ref, path);
      const problems = [];
      const counts = { identical: 0, derived: 0, intended: 0, added: 0, removed: 0, behaviour: 0, divergent: 0 };
      const sharedWorkflow = shared[name];
      const declaredInputs = sharedWorkflow.on?.workflow_call?.inputs ?? {};

      console.log();
      console.log(`  ${name}.yml — ${originalText === undefined ? `GAINED (no copy at ${ref})` : `replaces the copy at ${ref}`}; caller ${callerPath}`);
      if (!existsSync(callerPath)) {
        console.log('    ✗ no caller');
        problemsTotal += 1;
        continue;
      }
      const caller = YAML.parse(readFileSync(callerPath, 'utf8'));
      const original = originalText === undefined ? undefined : YAML.parse(originalText);

      // ── The caller: what stays in the repository, exactly as it was ───────
      const KEPT = ['name', 'on', 'permissions', 'concurrency'];
      for (const key of Object.keys(caller)) {
        if (![...KEPT, 'jobs'].includes(key)) problems.push(`caller: top-level \`${key}\` — nothing but ${KEPT.join(', ')} and the call belongs here`);
      }
      if (original) {
        for (const key of Object.keys(original)) {
          if (![...KEPT, 'jobs'].includes(key)) problems.push(`original: top-level \`${key}\` has no home in caller or shared workflow`);
        }
        for (const key of KEPT) {
          if (canon(caller[key]) !== canon(original[key])) {
            problems.push(`caller: \`${key}\` differs from the original\n          had:  ${canon(original[key])}\n          gets: ${canon(caller[key])}`);
          }
        }
      } else {
        for (const key of KEPT) if (caller[key] === undefined) problems.push(`caller: no \`${key}\``);
      }
      // The jobs run with what the caller grants; a called workflow can only narrow it.
      if (canon(caller.permissions) !== canon(sharedWorkflow.permissions)) {
        problems.push(`caller: permissions ${canon(caller.permissions)} ≠ the shared workflow's ${canon(sharedWorkflow.permissions)} — grant exactly that`);
      }
      const callerJobs = Object.entries(caller.jobs ?? {});
      if (callerJobs.length !== 1) problems.push(`caller: ${callerJobs.length} jobs — exactly one, the call, belongs here`);
      const [callerJobName, callerJob = {}] = callerJobs[0] ?? [];
      const callPattern = new RegExp(`^beplus/setup-beplus/\\.github/workflows/${name}\\.yml@\\S+$`);
      if (!callPattern.test(String(callerJob.uses ?? ''))) problems.push(`caller: job "${callerJobName}" does not call beplus/setup-beplus/.github/workflows/${name}.yml`);
      const originalJobName = original ? Object.keys(original.jobs ?? {})[0] : Object.keys(decl.jobs)[0];
      if (callerJobName !== originalJobName) {
        problems.push(`caller: job id "${callerJobName}" — keep "${originalJobName}", so the check is still "${originalJobName} / …"`);
      }
      for (const key of Object.keys(callerJob.with ?? {})) {
        if (!Object.hasOwn(declaredInputs, key)) problems.push(`caller: passes \`${key}\`, which the shared workflow does not declare — GitHub refuses the run`);
      }
      if (callerJob.secrets !== 'inherit') problems.push('caller: `secrets: inherit` — the token (and the connection strings) are the repository\'s');
      for (const key of Object.keys(callerJob)) {
        if (!['uses', 'with', 'secrets'].includes(key)) problems.push(`caller: job "${callerJobName}" sets \`${key}\` — the shared jobs own it`);
      }
      const inputs = Object.fromEntries(Object.entries(declaredInputs).map(([key, spec]) => [key, String(callerJob.with?.[key] ?? spec.default ?? '')]));
      const passed = Object.entries(callerJob.with ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no inputs';
      if (problems.length === 0) {
        console.log(`    ✓ caller  ${original ? `${KEPT.join(', ')} identical to the original` : 'its own triggers'}; one job "${callerJobName}", ${callerJob.uses}, ${passed}, secrets: inherit`);
      }

      // ── The derivation: the plan step, run on this estate's tree ──────────
      const plan = runPlan(sharedWorkflow, inputs, files, repository);
      if (plan.error) {
        problems.push(`plan: ${plan.error}`);
        for (const problem of problems) console.log(`    ✗ ${problem}`);
        problemsTotal += problems.length;
        continue;
      }
      console.log(`    ✓ plan    ${Object.entries(plan.outputs).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
      const scope = { inputs, outputs: plan.outputs };

      if (!original) {
        // Nothing to compare with: the caller, the derivation, and that every expression resolves.
        const used = { keys: new Set(), unknown: new Set() };
        resolveExpressions(sharedWorkflow.jobs, scope, used);
        for (const unknown of used.unknown) problems.push(`shared: ${unknown} resolves to nothing`);
        for (const problem of problems) console.log(`    ✗ ${problem}`);
        console.log(`    gained: ${Object.keys(sharedWorkflow.jobs).length} jobs, ${Object.values(sharedWorkflow.jobs).reduce((n, j) => n + (j.steps?.length ?? 0), 0)} steps${problems.length ? ` — ${problems.length} problem(s)` : ''}`);
        problemsTotal += problems.length;
        continue;
      }

      // ── The jobs: the shared workflow, resolved for this estate, vs the copy ─
      const sharedJobs = Object.keys(sharedWorkflow.jobs ?? {});
      const originalJobs = Object.keys(original.jobs ?? {});
      for (const job of sharedJobs.filter((j) => j !== 'plan' && !Object.values(decl.jobs).includes(j))) problems.push(`jobs: "${job}" is in the shared workflow and in no declaration`);
      for (const job of originalJobs.filter((j) => !Object.hasOwn(decl.jobs, j))) problems.push(`jobs: the original's "${job}" has no shared counterpart`);
      console.log(`    + job plan (reads the manifest; ${Object.keys(plan.outputs).join(', ')})`);

      for (const [originalJobName_, sharedJobName] of Object.entries(decl.jobs)) {
        if (!original.jobs?.[originalJobName_] || !sharedWorkflow.jobs?.[sharedJobName]) continue;
        const used = { keys: new Set(), unknown: new Set() };
        const { steps: rawSteps = [], ...rawJob } = sharedWorkflow.jobs[sharedJobName];
        const sharedJobRaw = resolveExpressions(rawJob, scope, used);
        const { steps: originalSteps = [], ...originalJobRaw } = original.jobs[originalJobName_];
        for (const unknown of used.unknown) problems.push(`job "${sharedJobName}": ${unknown} resolves to nothing`);

        // Job keys.
        const notes = [];
        let sharedJob = sharedJobRaw;
        if (sharedJob.needs === 'plan') { sharedJob = without(sharedJob, ['needs']); notes.push('needs: plan'); }
        if (sharedJob.environment === '') { sharedJob = without(sharedJob, ['environment']); notes.push('no github-environment: no environment, as the copy'); }
        const added = rewrite(sharedJob, decl.jobAdded ?? [], 'strip');
        const intended = rewrite(originalJobRaw, decl.jobIntended ?? [], 'apply');
        if (canon(added.value) !== canon(intended.value)) {
          problems.push(`job "${sharedJobName}": job keys differ\n          had:  ${canon(intended.value)}\n          gets: ${canon(added.value)}`);
        }
        console.log(`    job ${sharedJobName}  (${[...notes, ...added.applied.map((w) => `+ ${w}`), ...intended.applied.map((w) => `~ ${w}`)].join('; ') || 'keys identical'})`);

        // Steps, in order.
        const behaviour = decl.behaviour ?? {};
        let next = 0;
        const report = (mark, label, why) => console.log(`      ${mark} ${label.padEnd(58)} ${why}`);
        const skipRemoved = () => {
          while (next < originalSteps.length) {
            const removal = (decl.removedIfPresent ?? []).find((r) => r.match(originalSteps[next]));
            if (!removal) break;
            counts.removed += 1;
            report('−', stepKey(originalSteps[next]), `removed — ${removal.what}`);
            next += 1;
          }
        };
        for (const [i, raw] of rawSteps.entries()) {
          skipRemoved();
          const stepUsed = { keys: new Set(), unknown: new Set() };
          const step = resolveExpressions(raw, scope, stepUsed);
          for (const unknown of stepUsed.unknown) problems.push(`job "${sharedJobName}" step ${i + 1}: ${unknown} resolves to nothing`);
          const id = step.id;
          const ifAbsent = id ? decl.addedIfAbsent?.[id] : undefined;
          if (ifAbsent && !originalSteps.some(ifAbsent.present)) {
            counts.added += 1;
            report('+', stepKey(step), `added — ${ifAbsent.why}`);
            continue;
          }
          const theirs = originalSteps[next++];
          if (!theirs) {
            counts.divergent += 1;
            problems.push(`job "${sharedJobName}" step ${i + 1}: only in the shared workflow — ${stepKey(step)}`);
            report('✗', stepKey(step), 'only in the shared workflow');
            continue;
          }
          const mine = without(step, ['id']); // an id is a label; nothing in these jobs reads one
          const plain = without(raw, ['id']);
          if (canon(plain) === canon(theirs)) {
            counts.identical += 1;
            report('✓', stepKey(step), 'identical');
            continue;
          }
          const stripped = rewrite(mine, decl.stepAdded ?? [], 'strip');
          const target = rewrite(theirs, decl.stepIntended ?? [], 'apply');
          const spec = id ? behaviour[id] : undefined;
          if (spec) {
            // Everything but the body must match; the body must BEHAVE the same.
            const structural = { ...stripped.value, env: without(stripped.value.env, spec.added), run: undefined };
            const structuralTarget = { ...target.value, run: undefined };
            if (Object.keys(structural.env).length === 0) delete structural.env;
            if (canon(structural) !== canon(structuralTarget)) {
              counts.divergent += 1;
              problems.push(`job "${sharedJobName}" step ${i + 1} "${stepKey(mine)}" differs beyond its body\n          had:  ${canon(structuralTarget)}\n          gets: ${canon(structural)}`);
              report('✗', stepKey(mine), 'DIVERGENT (keys)');
              continue;
            }
            const envs = String(plan.outputs.environments ?? '').split(' ').filter(Boolean);
            const runs = behaves(spec.scenarios, envs, theirs, mine, originalJobRaw.env, sharedJobRaw.env);
            const bad = runs.filter((r) => !r.same);
            if (bad.length) {
              counts.divergent += 1;
              for (const r of bad) {
                problems.push(`job "${sharedJobName}" step ${i + 1} "${stepKey(mine)}" behaves differently — ${r.scenario}\n          had:  exit ${r.before.status} ${JSON.stringify(r.before.stdout + r.before.stderr)}\n          gets: exit ${r.after.status} ${JSON.stringify(r.after.stdout + r.after.stderr)}`);
              }
              report('✗', stepKey(mine), `DIVERGENT in ${bad.length}/${runs.length} scenarios`);
            } else {
              counts.behaviour += 1;
              const why = [`run side by side: same output and exit in ${runs.length} scenarios (${spec.scenarios})`, ...target.applied, ...stripped.applied.map((w) => `+ ${w}`)];
              report('≡', stepKey(mine), why.join('; '));
            }
            continue;
          }
          if (canon(stripped.value) === canon(target.value)) {
            const why = [...target.applied.map((w) => `intended: ${w}`), ...stripped.applied.map((w) => `+ ${w}`)];
            if (target.applied.length || stripped.applied.length) counts.intended += 1; else counts.derived += 1;
            report(target.applied.length || stripped.applied.length ? '~' : '✓', stepKey(mine),
              [why.join('; '), stepUsed.keys.size ? `derived: ${[...stepUsed.keys].join(', ')}` : ''].filter(Boolean).join('; '));
            continue;
          }
          counts.divergent += 1;
          problems.push(`job "${sharedJobName}" step ${i + 1} "${stepKey(mine)}" differs\n          had:  ${canon(target.value)}\n          gets: ${canon(stripped.value)}`);
          report('✗', stepKey(mine), 'DIVERGENT');
        }
        skipRemoved();
        for (; next < originalSteps.length; next += 1) {
          counts.divergent += 1;
          problems.push(`job "${sharedJobName}": the original's step "${stepKey(originalSteps[next])}" is missing from the shared workflow`);
          report('✗', stepKey(originalSteps[next]), 'MISSING from the shared workflow');
        }
      }

      for (const problem of problems) console.log(`    ✗ ${problem}`);
      const steps = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`    ${steps} steps: ${counts.identical} identical, ${counts.derived} identical once derived, ${counts.intended} intended, ` +
        `${counts.behaviour} rewritten and run side by side, ${counts.added} added, ${counts.removed} removed, ${counts.divergent} divergent` +
        `${problems.length ? ` — ${problems.length} problem(s)` : ''}`);
      problemsTotal += problems.length;
      for (const k of Object.keys(totals)) totals[k] += counts[k];
    }
  }

  console.log();
  console.log(`  ${entries.length} estate(s): ${totals.identical} identical, ${totals.derived} identical once derived, ${totals.intended} intended, ` +
    `${totals.behaviour} run side by side, ${totals.added} added, ${totals.removed} removed, ${totals.divergent} divergent step(s)`);
  console.log(problemsTotal === 0
    ? '  every caller + db-migrations-pr.yml / db-drift-env.yml reproduces the workflow it replaces'
    : `  ${problemsTotal} problem(s): a caller would not do what its workflow did before`);
  process.exit(problemsTotal === 0 ? 0 : 1);
};

// ─────────────────────────────────────────────────────────────────────────────
const [first, ...rest] = process.argv.slice(2);
if (!first) usage();
if (first === 'infra-diff') infraDiff(rest);
else if (first === 'db') databaseWorkflows(rest);
else if (existsSync(first)) libraries(first);
else usage();
