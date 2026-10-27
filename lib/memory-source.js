import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MEMORY_PLUGIN_NAME = 'dsh-plugin-memory';
const REQUIRED_FILES = ['SOUL.md', 'BOOTSTRAP.md'];

function regularFileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function directoryPath(value, cwd, home) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const text = value.trim();
  if (text === '~') return resolve(home);
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(home, text.slice(2));
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text);
}

function pathKey(path) { return process.platform === 'win32' ? path.toLowerCase() : path; }

function activeMemoryEntries(loader) {
  if (!loader || typeof loader.entries !== 'function') return [];
  try {
    return [...loader.entries()].filter((entry) => entry?.options?.name === MEMORY_PLUGIN_NAME &&
      !entry.disabled && !entry.options.disabled && entry.fiber && entry.fiber.state === 2);
  } catch { return null; }
}

/**
 * Find a memory directory without reading memory contents or configuration files.
 *
 * memoryConfig is the effective config obtained by the signed-in browser from
 * the memory plugin's same-origin /api/memory/config route. That plugin keeps
 * its MemoryConfigStore in a closure, so loader fiber.config is only the base
 * composition config, not its current memory.json or hot-edited value.
 *
 * A previously selected/bound directory is pinned. All other differing usable
 * directories require a choice. Only the known memory plugin is auto-discovered;
 * another provider can use explicitMemoryDir, MEMORY_DIR, or a workspace folder.
 * This function never interprets BOOTSTRAP, infers completion, or makes HTTP calls.
 */
export function discoverMemorySource({
  loader,
  explicitMemoryDir,
  memoryConfig,
  selectedMemoryDir,
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  exists = regularFileExists,
} = {}) {
  const candidates = [];
  const warnings = [];
  const detected = activeMemoryEntries(loader);
  const active = detected || [];
  const hasRuntime = memoryConfig !== undefined && memoryConfig !== null;
  const knownMemory = active.length > 0 || hasRuntime || detected === null;
  const memoryConfigRequired = (active.length > 0 || detected === null) && !hasRuntime;
  const add = (value, source, { authoritative = true } = {}) => {
    const path = directoryPath(value, cwd, home);
    if (!path) return null;
    const existing = candidates.find((candidate) => pathKey(candidate.path) === pathKey(path));
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.authoritative ||= authoritative;
      return existing;
    }
    const missing = REQUIRED_FILES.filter((file) => {
      try { return !exists(join(path, file)); } catch { return true; }
    });
    const candidate = { path, source, sources: [source], available: missing.length === 0, missing, authoritative };
    candidates.push(candidate);
    return candidate;
  };
  const result = (status, chosen, reason) => ({
    status,
    ...(chosen ? { memoryDir: chosen.path } : {}),
    candidates,
    memoryConfigRequired,
    reason,
    warnings,
  });

  // Existing bindings must never silently follow a different profile or store.
  if (selectedMemoryDir !== undefined && selectedMemoryDir !== null && selectedMemoryDir !== '') {
    const selected = add(selectedMemoryDir, 'selected');
    return selected?.available
      ? result('ready', selected, '沿用已选择的人设目录。')
      : result('not_found', selected, '已选择的目录缺少 SOUL.md 或 BOOTSTRAP.md；不会自动换用其他伙伴。');
  }

  const explicit = add(explicitMemoryDir, 'explicit');
  if (hasRuntime) {
    if (typeof memoryConfig !== 'object' || Array.isArray(memoryConfig) || typeof memoryConfig.memoryDir !== 'string' || !memoryConfig.memoryDir.trim()) {
      return result('needs_memory_config', null, '长期记忆插件返回的目录配置无效，请在已登录的 DSH 页面重新读取。');
    }
    const runtime = add(memoryConfig.memoryDir, 'memory_plugin_runtime');
    if (memoryConfig.enabled === false) {
      warnings.push('长期记忆插件当前已停用；只有明确选择目录后才可继续。');
      if (!explicit) return result('needs_selection', null, '记忆插件已停用，请确认要使用的人设目录。');
    }
    // Keep a malformed/unsupported runtime path visible rather than falling back.
    if (!runtime) return result('needs_memory_config', null, '长期记忆插件的目录无法解析。');
  }

  if (memoryConfigRequired) {
    for (const entry of active) {
      const composition = entry.fiber.config || entry.options.config || {};
      add(composition.memoryDir || '~/.memory', 'memory_plugin_composition', { authoritative: false });
    }
    return result('needs_memory_config', null, '需要从已登录页面读取长期记忆插件的当前配置；安装配置只是默认值。');
  }

  if (!knownMemory) {
    add(env?.MEMORY_DIR, 'environment');
    add(join(cwd, '.memory'), 'workspace');
  }

  const available = candidates.filter((candidate) => candidate.available && candidate.authoritative);
  if (available.length > 1) return result('needs_selection', null, '发现多个不同的人设目录，请选择本次要接入的伙伴。');
  if (available.length === 1) {
    const candidate = available[0];
    if (explicit && !explicit.available && pathKey(explicit.path) !== pathKey(candidate.path)) {
      return result('needs_selection', null, '指定目录不完整，另有可用目录；请明确选择，避免接入错误伙伴。');
    }
    return result('ready', candidate, '找到包含 SOUL.md 与 BOOTSTRAP.md 的人设目录；铸魂是否完成仍需单独检查。');
  }
  return result('not_found', null, '未找到包含 SOUL.md 与 BOOTSTRAP.md 的人设目录。可明确指定其他记忆插件使用的目录。');
}
