/** Opt-in real pnpm regression. Uses only a new isolated profile and public pinned releases. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHostUpdateAdapter } from '../lib/update-host.js';

const entry = process.argv[2];
assert.ok(entry && existsSync(entry), 'Pass the pnpm 11.28.5 bin/pnpm.mjs absolute path; no package manager is installed or upgraded.');
const root = resolve('.test-work', 'pnpm-stale-' + randomUUID());
mkdirSync(root, { recursive: true });
const oldCommit = 'b40f43df31a9cae16e5d894d7845210e42457020';
const commit = 'cebaa4804205e789b010eeae256846c1c2ee0a43';
const target = { version: '0.5.18', commit, spec: `github:bzny/dsh-plugin-tangui#${commit}` };
const profileFile = join(root, 'package.json');
const marker = join(root, 'unexpected-install-hook.txt');
const hook = `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replaceAll('"', "'")},'unexpected')"`;
writeFileSync(profileFile, JSON.stringify({ name: 'isolated-pnpm-regression', version: '1.0.0', private: true, scripts: { preinstall: hook } }));
const workspacePolicy = 'nodeLinker: hoisted\nallowBuilds:\n  dsh-plugin-tangui: true\n';
writeFileSync(join(root, 'pnpm-workspace.yaml'), workspacePolicy);
let count = 0;
const commands = [];
async function run(_context, args) {
  const number = ++count;
  const child = spawn(process.execPath, [resolve(entry), ...args, '--config.auto-install-peers=false',
    '--store-dir', join(root, 'store'), '--fetch-retries=0', '--reporter=append-only'],
  { cwd: root, windowsHide: true, env: { ...process.env, CI: 'true' } });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const exitCode = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  writeFileSync(join(root, `pnpm-${number}.txt`), output);
  commands.push({ number, exitCode, ignoredBuildError: output.includes('ERR_PNPM_IGNORED_BUILDS'), offline: args.includes('--offline') });
  console.log(JSON.stringify(commands.at(-1)));
  return { exitCode, output };
}
const version = () => JSON.parse(readFileSync(join(root, 'node_modules/dsh-plugin-tangui/package.json'))).version;
assert.equal((await run(null, ['add', '--ignore-scripts', '--config.strict-dep-builds=false', `github:bzny/dsh-plugin-tangui#${oldCommit}`])).exitCode, 0);
const ctx = { get: name => name === 'profileContext' ? { dir: root, installAnchor: profileFile } : undefined };
const adapter = createHostUpdateAdapter(ctx, { packageRoot: join(root, 'node_modules/dsh-plugin-tangui'),
  reconcile: async () => ({}), withFileLock: (_path, work) => work(), runProfilePnpm: run });
const original = await adapter.host.snapshot();
await adapter.host.restore(original);
function seedStaleRecords(archive) {
  const file = join(root, 'node_modules/.modules.yaml');
  // pnpm 11.28.5 writes JSON to this historically named file.
  const metadata = JSON.parse(readFileSync(file));
  metadata.ignoredBuilds = [
    `dsh-plugin-tangui@https://codeload.github.com/bzny/dsh-plugin-tangui/tar.gz/${commit}`,
    'dsh-plugin-tangui@file:' + relative(root, archive).replaceAll('\\', '/'),
  ];
  writeFileSync(file, JSON.stringify(metadata, null, 2));
}
seedStaleRecords(original.archivePath);
const failedUpgrade = await run(null, ['add', '--ignore-scripts', target.spec]);
assert.equal(failedUpgrade.exitCode, 1);
assert.match(failedUpgrade.output, /ERR_PNPM_IGNORED_BUILDS/);
assert.equal(version(), '0.5.18', 'pnpm fails after the new files are already installed');
const failedRestore = await run(null, ['add', '--ignore-scripts', '--offline', `dsh-plugin-tangui@file:${original.archivePath}`]);
assert.equal(failedRestore.exitCode, 1);
assert.match(failedRestore.output, /ERR_PNPM_IGNORED_BUILDS/);
assert.equal(version(), '0.5.17', 'the old files are already restored despite pnpm reporting failure');
const snapshot = await adapter.host.snapshot();
seedStaleRecords(original.archivePath);
await adapter.host.install(target);
assert.equal(version(), '0.5.18');
await adapter.host.restore(snapshot);
assert.equal(version(), '0.5.17');
assert.equal(existsSync(marker), false, 'root lifecycle scripts remain disabled');
const approvals = text => [...text.matchAll(/^\s*(.+):\s*true\s*$/gm)].map(match => match[1].trim()).sort();
assert.deepEqual(approvals(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')), approvals(workspacePolicy), 'no persistent build approval is added');
writeFileSync(join(root, 'result.json'), JSON.stringify({ result: 'passed', commands }, null, 2));
console.log(JSON.stringify({ result: 'passed', pnpm: '11.28.5', staleRecordsReproducedBothFailures: true,
  patchedUpgradeAndOfflineRestorePassed: true, scriptsExecuted: false, persistentBuildApprovalAdded: false }));
