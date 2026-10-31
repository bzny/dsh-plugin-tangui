import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Release-owned aliases of the same operator-authorized community/database.
// Never accept a redirect or a server-supplied URL as authority to move a token.
export const DEFAULT_COMMUNITY_ORIGIN = 'https://csiparty.natapp1.cc';
export const PREVIOUS_COMMUNITY_ORIGIN = 'https://test.csiparty.cn';
export const currentCommunityOrigin = value => value === PREVIOUS_COMMUNITY_ORIGIN ? DEFAULT_COMMUNITY_ORIGIN : value;
export const sameCommunityOrigin = (left, right) => typeof left === 'string' && !!left &&
  typeof right === 'string' && currentCommunityOrigin(left) === currentCommunityOrigin(right);
export function currentCommunityLink(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.origin === PREVIOUS_COMMUNITY_ORIGIN && !url.username && !url.password) {
      return `${DEFAULT_COMMUNITY_ORIGIN}${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* Existing validation owns malformed links. */ }
  return value;
}

export function migrateBindingOrigin(binding) {
  if (!binding || binding.baseUrl !== PREVIOUS_COMMUNITY_ORIGIN) return false;
  binding.storageBaseUrl = PREVIOUS_COMMUNITY_ORIGIN;
  binding.baseUrl = DEFAULT_COMMUNITY_ORIGIN;
  return true;
}

export function backupBeforeOriginChange(file) {
  if (!existsSync(file)) return;
  try { copyFileSync(file, `${file}.before-a2-origin`, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// Keep the original private storage location so changing an API endpoint does
// not reset budgets, reading cursors, pending requests or local diary history.
// Manual switches retain an already existing current store. This lookup never
// moves, merges, deletes or uploads private files.
export function communityStoragePath(directory, baseUrl, actorId, { storageBaseUrl, length = 64, suffix = '' } = {}) {
  const path = origin => join(directory, createHash('sha256').update(`${origin}\n${actorId}`).digest('hex').slice(0, length) + suffix);
  const current = path(baseUrl);
  if (storageBaseUrl && sameCommunityOrigin(storageBaseUrl, baseUrl)) {
    const previous = path(storageBaseUrl);
    return existsSync(previous) || !existsSync(current) ? previous : current;
  }
  if (baseUrl === DEFAULT_COMMUNITY_ORIGIN && !existsSync(current)) {
    const previous = path(PREVIOUS_COMMUNITY_ORIGIN);
    if (existsSync(previous)) return previous;
  }
  return current;
}
