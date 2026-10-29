import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const PACKAGE = 'dsh-plugin-tangui';
const REPOSITORY = 'github:bzny/dsh-plugin-tangui';
const GLOBAL = Symbol.for('dsh-plugin-tangui.update-host.v1');
const shared = globalThis[GLOBAL] ||= { versions: new Map() };
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const ROOT_FILES = ['package.json', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md'];

export function updateProfileKey(profileDir) {
  const path = resolve(profileDir);
  let canonical;
  try { canonical = realpathSync(path); } catch { canonical = path; }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** A live apply registers only after setup succeeds. Its disposer cannot clear a newer apply. */
export function registerActiveVersion(version, { profileDir }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('invalid active version');
  const key = updateProfileKey(profileDir);
  const record = { version, id: randomUUID() };
  shared.versions.set(key, record);
  return () => { if (shared.versions.get(key) === record) shared.versions.delete(key); };
}

function within(parent, child) {
  const part = relative(resolve(parent), resolve(child));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

function jsonAt(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function dependency(profileDir) { return jsonAt(join(profileDir, 'package.json')).dependencies?.[PACKAGE]; }
function unnamedSource(source) { return typeof source === 'string' && source.startsWith(`${PACKAGE}@`) ? source.slice(PACKAGE.length + 1) : source; }
function sourceChanged() {
  return Object.assign(new Error('installation source changed'), { code: 'update_source_changed', skipRollback: true });
}
function sameSource(left, right) { return unnamedSource(left) === unnamedSource(right); }
function matchesTarget(source, target) {
  const value = unnamedSource(source);
  return !!target && isOfficialGitSource(value) && value.split('#')[1]?.toLowerCase() === target.commit.toLowerCase();
}

/** Never accept a release-supplied repository, query string, credentials, or arbitrary local source. */
export function isOfficialGitSource(source) {
  if (typeof source !== 'string') return false;
  return /^(?:github:bzny\/dsh-plugin-tangui|(?:git\+)?https:\/\/github\.com\/bzny\/dsh-plugin-tangui(?:\.git)?|git@github\.com:bzny\/dsh-plugin-tangui(?:\.git)?|git\+ssh:\/\/git@github\.com\/bzny\/dsh-plugin-tangui(?:\.git)?)(?:#[A-Za-z0-9._/-]+)?$/.test(source);
}

function backupSource(source, profileDir, backupRoot) {
  if (typeof source !== 'string' || !source.startsWith('file:')) return null;
  const archive = resolve(profileDir, source.slice(5));
  if (!within(backupRoot, archive) || archive !== join(dirname(archive), 'package.tgz')) return null;
  try {
    // Reject substituted links even when their apparent path is inside the updater directory.
    if (!within(realpathSync(backupRoot), realpathSync(archive))) return null;
    const metadata = jsonAt(join(dirname(archive), 'snapshot.json'));
    if (metadata.packageName !== PACKAGE || metadata.archive !== 'package.tgz' ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) || hash(readFileSync(archive)) !== metadata.sha256) return null;
    return { ...metadata, archivePath: archive };
  } catch { return null; }
}

/** No external archive utility or package lifecycle scripts are used to create recovery material. */
function tarGzip(files) {
  const blocks = [];
  for (const { name, data } of files) {
    const path = `package/${name}`;
    if (Buffer.byteLength(path) > 100) throw new Error('backup path is too long');
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, 'utf8');
    const octal = (value, offset, width) => header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function releaseFiles(packageRoot) {
  const files = [];
  let bytes = 0;
  const add = async (name, required = false) => {
    const path = join(packageRoot, name);
    let info;
    try { info = await lstat(path); } catch (error) { if (!required && error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe backup entry');
    if ((bytes += info.size) > MAX_BACKUP_BYTES) throw new Error('backup package is too large');
    const data = await readFile(path);
    files.push({ name: name.replaceAll('\\', '/'), data });
  };
  for (const name of ROOT_FILES) await add(name, name === 'package.json' || name === 'cordis.patch.yml');
  const walk = async (directory, prefix) => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe backup directory');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ['node_modules', 'data', 'state', 'test', 'tests'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('unsafe backup link');
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (/\.(?:[cm]?js|d\.ts)$/.test(entry.name)) await add(name);
    }
  };
  await walk(join(packageRoot, 'lib'), 'lib');
  if (!files.some(file => file.name === 'lib/index.js')) throw new Error('backup has no plugin entry');
  return files;
}

function serviceOf(ctx, name) { return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]; }
function profileOf(ctx) { return serviceOf(ctx, 'profileContext'); }
function hmrOf(ctx) { return serviceOf(ctx, 'hmr'); }

/**
 * The returned host owns no ctx.effect and survives replacement of the plugin that requested it.
 * For tests, inject runProfilePnpm/withFileLock/reconcile/getActiveVersion against an isolated profile.
 */
export function createHostUpdateAdapter(ctx, {
  packageRoot,
  entryIds = ['tangui-registration'],
  tryAcquireIdleLock = () => null,
  runProfilePnpm: injectedPnpm,
  withFileLock: injectedLock,
  // Compatibility alias for existing injected test doubles; production never nests runPluginCommand's lock.
  runPluginCommand: injectedCommand,
  reconcile: injectedReconcile,
  getActiveVersion: injectedActiveVersion,
} = {}) {
  const profile = profileOf(ctx);
  const profileDir = profile?.dir;
  if (!profileDir || !packageRoot) return { mode: 'check-only', reason: 'host-unavailable', profileDir, host: null };
  const backupRoot = join(profileDir, '.plugin-manager', 'tangui-updates');
  let source;
  let installedRoot;
  try {
    source = dependency(profileDir);
    installedRoot = realpathSync(join(profileDir, 'node_modules', PACKAGE));
    if (updateProfileKey(installedRoot) !== updateProfileKey(packageRoot) || jsonAt(join(installedRoot, 'package.json')).name !== PACKAGE) {
      return { mode: 'check-only', reason: 'installation-mismatch', profileDir, host: null };
    }
  } catch { return { mode: 'check-only', reason: 'installation-unavailable', profileDir, host: null }; }
  const managedSource = () => {
    const current = dependency(profileDir);
    return isOfficialGitSource(current) || backupSource(current, profileDir, backupRoot) !== null;
  };
  if (!managedSource()) {
    const development = /^(?:file|link):/.test(source || '');
    return { mode: development ? 'development' : 'check-only', reason: development ? 'development-source' : 'untrusted-source', profileDir, host: null };
  }
  const hmr = hmrOf(ctx);
  if (!injectedReconcile && (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function')) {
    return { mode: 'check-only', reason: 'reload-unavailable', profileDir, host: null };
  }
  let operationUrl, lockUrl;
  if (!(injectedPnpm || injectedCommand) || !injectedLock) {
    try {
      const require = createRequire(profile.installAnchor);
      if (!(injectedPnpm || injectedCommand)) operationUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href;
      if (!injectedLock) lockUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href;
    }
    catch { return { mode: 'check-only', reason: 'installer-unavailable', profileDir, host: null }; }
  }
  // Capture host service/functions, not a disposed plugin context or a cancellable plugin effect.
  const operationContext = { profile: profile.name, dir: profileDir, installAnchor: profile.installAnchor, cwd: profile.cwd, home: profile.home };
  const operationOptions = { execution: 'service', outputBytes: 65536, lockWaitMs: 120000, idleTimeoutMs: 600000,
    activateNewBundles: false, ...profile.packageManager };
  const locked = async (operation) => {
    const withFileLock = injectedLock ?? (await import(lockUrl)).withFileLock;
    return withFileLock(join(profileDir, 'package.json'), operation, { waitMs: operationOptions.lockWaitMs });
  };
  const command = async (spec, { offline = false } = {}) => {
    // This lower-level public API explicitly requires the caller's profile write lock.
    const run = injectedPnpm ?? injectedCommand ?? (await import(operationUrl)).runProfilePnpm;
    // Name the existing dependency explicitly: a bare tarball can leave its old Git
    // dependency in pnpm's resolution plan, which defeats an offline rollback.
    const result = await run(operationContext, ['add', '--ignore-scripts', ...(offline ? ['--offline'] : []), `${PACKAGE}@${spec}`], operationOptions);
    if (result?.exitCode !== 0 || result?.timedOut || result?.incompatible?.length) throw new Error('plugin package installation failed');
    return result;
  };
  let latestSnapshot;
  let attemptedTarget;
  const host = {
    tryAcquireIdleLock,
    async snapshot() {
      return locked(async () => {
      if (!managedSource()) throw sourceChanged();
      const originalDependency = dependency(profileDir);
      const root = realpathSync(join(profileDir, 'node_modules', PACKAGE));
      const manifest = jsonAt(join(root, 'package.json'));
      if (manifest.name !== PACKAGE || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('wrong installed package');
      const archive = tarGzip(await releaseFiles(root));
      await mkdir(backupRoot, { recursive: true });
      const directory = join(backupRoot, randomUUID());
      await mkdir(directory);
      const archivePath = join(directory, 'package.tgz');
      const metadata = { packageName: PACKAGE, version: manifest.version, originalDependency,
        archive: 'package.tgz', sha256: hash(archive), createdAt: new Date().toISOString() };
      await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
      await writeFile(join(directory, 'snapshot.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      latestSnapshot = { ...metadata, archivePath };
      attemptedTarget = null;
      return latestSnapshot;
      });
    },
    async install({ version, commit, spec }) {
      let writeStarted = false;
      try {
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/i.test(commit) || spec !== `${REPOSITORY}#${commit}`) {
          throw new Error('invalid fixed release target');
        }
        return await locked(async () => {
          // The check and package write share the exact lock used by DSH's manager and CLI.
          // A source changed by another package operation is never replaced or rolled back.
          if (!latestSnapshot || !sameSource(dependency(profileDir), latestSnapshot.originalDependency) || !managedSource()) throw sourceChanged();
          attemptedTarget = { version, commit, spec, snapshotPath: latestSnapshot.archivePath };
          writeStarted = true;
          await command(spec);
          const installed = jsonAt(join(profileDir, 'node_modules', PACKAGE, 'package.json'));
          if (installed.name !== PACKAGE || installed.version !== version) throw new Error('installed version differs from release');
          return {};
        });
      } catch (error) {
        if (!writeStarted && error?.skipRollback !== true) {
          throw Object.assign(new Error('package update did not start'), { code: 'update_install_not_started', skipRollback: true });
        }
        throw error;
      }
    },
    async activate() {
      const result = injectedReconcile ? await injectedReconcile(entryIds) : await hmr.runExclusive(() => hmr.reconcileProfile(entryIds));
      if (result?.restartReason || result?.pending?.length) return { restartRequired: true,
        restartReason: result.restartReason ?? result.pending[0]?.reason ?? 'host-restart-required' };
      return {};
    },
    getActiveVersion() { return injectedActiveVersion ? injectedActiveVersion() : shared.versions.get(updateProfileKey(profileDir))?.version ?? null; },
    async restore(snapshot) {
      return locked(async () => {
      if (!snapshot?.archivePath || !within(backupRoot, snapshot.archivePath)) throw new Error('invalid recovery snapshot');
      const verified = backupSource(`file:${snapshot.archivePath}`, profileDir, backupRoot);
      if (!verified || verified.sha256 !== snapshot.sha256 || verified.version !== snapshot.version || verified.originalDependency !== snapshot.originalDependency) throw new Error('recovery archive changed');
      const current = dependency(profileDir);
      const currentBackup = backupSource(unnamedSource(current), profileDir, backupRoot);
      const sameBackup = currentBackup && updateProfileKey(currentBackup.archivePath) === updateProfileKey(snapshot.archivePath) && currentBackup.sha256 === snapshot.sha256;
      const target = attemptedTarget?.snapshotPath === snapshot.archivePath ? attemptedTarget : null;
      if (!sameSource(current, snapshot.originalDependency) && !matchesTarget(current, target) && !sameBackup) throw sourceChanged();
      await command(`file:${verified.archivePath}`, { offline: true });
      const installed = jsonAt(join(profileDir, 'node_modules', PACKAGE, 'package.json'));
      if (installed.name !== PACKAGE || installed.version !== snapshot.version) throw new Error('recovered version differs from snapshot');
      return {};
      });
    },
  };
  return { mode: 'managed', reason: null, profileDir, host };
}

export async function createUpdateHost({ ctx, ...options }) {
  return createHostUpdateAdapter(ctx, options);
}
