import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const opsPath = fileURLToPath(new URL('../deploy/production/mirrorterra-ops', import.meta.url));
const opsSource = readFileSync(opsPath, 'utf8');

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mirrorterra-release-ops-'));
  const releases = path.join(root, 'releases');
  const state = path.join(root, 'state');
  const current = path.join(root, 'current');
  const trace = path.join(root, 'trace');
  for (const release of ['old', 'new', 'other']) {
    const releaseDir = path.join(releases, release, 'src');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(path.join(releaseDir, 'server.js'), '// fixture');
  }
  symlinkSync(path.join(releases, 'old'), current);
  mkdirSync(state, { recursive: true });
  return { root, releases, state, current, trace };
}

function runShell(fixture, body, { now = 10_000 } = {}) {
  return spawnSync('bash', ['-c', `source "$OPS_HELPER"\n${body}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPS_HELPER: opsPath,
      TEST_ROOT: fixture.root,
      TEST_NOW: String(now),
    },
  });
}

function commonSetup() {
  return `
STATE="$TEST_ROOT/state"
CFG_BAK="$STATE/config-backups"
REL_ROOT="$TEST_ROOT/releases"
CURRENT="$TEST_ROOT/current"
SYNTERRA_RESTART_LOCK="$STATE/synterra-release.lock"
SYNTERRA_RESTART_MARKER="$STATE/last-synterra-restart-at"
now_epoch() { printf '%s\\n' "$TEST_NOW"; }
flock() { return 0; }
logger() { return 0; }
systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/trace"; }
mv() {
  if [ "$1" = -T ]; then
    /bin/rm -f "$3"
    command mv "$2" "$3"
  else
    command mv "$@"
  fi
}
wait_for_local_ready() { printf 'ready\\n' >> "$TEST_ROOT/trace"; return 0; }
verify_public_endpoints() { printf 'public\\n' >> "$TEST_ROOT/trace"; return 0; }
`;
}

function traceLines(fixture) {
  try {
    return readFileSync(fixture.trace, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('release-install remains a prepare-only operation with no production restart', () => {
  const installBlock = opsSource.split('release-install)')[1]?.split('release-activate)')[0] ?? '';
  assert.match(installBlock, /installed .*\(not active\)/);
  assert.doesNotMatch(installBlock, /systemctl|activate\s/);
});

test('final release activation restarts once, then waits for local readiness and public 200 probes', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = runShell(fixture, `${commonSetup()}\nactivate new\nprintf 'current=%s\\n' "$(readlink -f "$CURRENT")"`, { now: 10_000 });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(traceLines(fixture), ['restart synterra.service', 'ready', 'public']);
  assert.equal(readFileSync(path.join(fixture.state, 'last-synterra-restart-at'), 'utf8').trim(), '10000');
  assert.equal(readFileSync(path.join(fixture.state, 'previous-release'), 'utf8').trim(), realpathSync(path.join(fixture.releases, 'old')));
  assert.match(result.stdout, new RegExp(`current=${realpathSync(path.join(fixture.releases, 'new'))}`));
});

test('re-activating the already-current release exits before cooldown, restart, and health checks', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  rmSync(fixture.current);
  // Replace the initial release pointer and seed an active cooldown.
  symlinkSync(path.join(fixture.releases, 'new'), fixture.current);
  writeFileSync(path.join(fixture.state, 'last-synterra-restart-at'), '9999');

  const result = runShell(fixture, `${commonSetup()}\nactivate new`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already active .* no restart or health check/);
  assert.deepEqual(traceLines(fixture), []);
  assert.equal(readFileSync(path.join(fixture.state, 'last-synterra-restart-at'), 'utf8').trim(), '9999');
});

test('different release activation is rejected during the 15-minute cooldown without switching current', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(path.join(fixture.state, 'last-synterra-restart-at'), '1000');

  const result = runShell(fixture, `${commonSetup()}\nactivate new`, { now: 1899 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cooldown active for 1s/);
  assert.equal(readlinkTarget(fixture.current), realpathSync(path.join(fixture.releases, 'old')));
  assert.deepEqual(traceLines(fixture), []);
});

test('cooldown expires at 15 minutes, not before', () => {
  const result = spawnSync('bash', ['-c', `source "$OPS_HELPER"; printf '%s %s\\n' "$(restart_cooldown_remaining 1000 1899)" "$(restart_cooldown_remaining 1000 1900)"`], {
    encoding: 'utf8',
    env: { ...process.env, OPS_HELPER: opsPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1 0');
});

test('a readiness failure retains cooldown and prevents a second restart attempt', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const failed = runShell(fixture, `${commonSetup()}
wait_for_local_ready() { printf 'ready-failed\\n' >> "$TEST_ROOT/trace"; return 1; }
activate new`, { now: 20_000 });

  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /cooldown remains active/);
  assert.equal(readFileSync(path.join(fixture.state, 'last-synterra-restart-at'), 'utf8').trim(), '20000');
  assert.deepEqual(traceLines(fixture), ['restart synterra.service', 'ready-failed']);

  rmSync(fixture.trace, { force: true });
  const retry = runShell(fixture, `${commonSetup()}\nactivate old`, { now: 20_001 });
  assert.equal(retry.status, 2);
  assert.match(retry.stderr, /cooldown active/);
  assert.deepEqual(traceLines(fixture), []);
});

test('a failed systemctl restart attempt still starts the cooldown', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const failed = runShell(fixture, `${commonSetup()}
systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/trace"; return 1; }
restart_unit synterra`, { now: 25_000 });

  assert.equal(failed.status, 1);
  assert.equal(readFileSync(path.join(fixture.state, 'last-synterra-restart-at'), 'utf8').trim(), '25000');
  assert.deepEqual(traceLines(fixture), ['restart synterra.service']);
});

test('generic synterra restart shares the activation cooldown', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const first = runShell(fixture, `${commonSetup()}\nrestart_unit synterra`, { now: 30_000 });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(traceLines(fixture), ['restart synterra.service', 'ready', 'public']);

  rmSync(fixture.trace, { force: true });
  const second = runShell(fixture, `${commonSetup()}\nrestart_unit synterra`, { now: 30_001 });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /cooldown active/);
  assert.deepEqual(traceLines(fixture), []);
});

test('a concurrent activation is rejected before changing the active release', (t) => {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = runShell(fixture, `${commonSetup()}
flock() { return 1; }
activate new`);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /another production activation\/restart is in progress/);
  assert.equal(readlinkTarget(fixture.current), realpathSync(path.join(fixture.releases, 'old')));
  assert.deepEqual(traceLines(fixture), []);
});

function readlinkTarget(link) {
  const result = spawnSync('readlink', ['-f', link], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
