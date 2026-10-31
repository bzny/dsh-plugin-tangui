import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicState } from './runtime-api.js';

const MAX_BYTES = 256 * 1024, MAX_COUNT = 20, MAX_AGE_MS = 7 * 86400000;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const namePattern = /^\d{13}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i;
const truncate = (text, limit) => new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(text).subarray(0, Math.max(0, limit))).replace(/\uFFFD$/, '');
function redact(text) {
  return text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '[思考内容已省略]')
    .replace(/\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[凭证已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [凭证已省略]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authtoken|password|密码|密钥)["']?\s*[:=：]\s*["']?)[^\s"',}\]&]+/gi, '$1[凭证已省略]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭证已省略]@')
    .replace(/([?&](?:token|key|secret|signature|auth)=)[^&\s"']+/gi, '$1[凭证已省略]');
}

/** Opt-in local diagnostic samples. Never exposed via the public status or tools. */
export function createFailureSampleStore({ directory, settingsFile, now = () => Date.now() }) {
  directory = resolve(directory);
  let enabled = false, storageError = false;
  try { enabled = JSON.parse(readFileSync(settingsFile, 'utf8')).capture_failed_output === true; }
  catch (error) { if (error.code !== 'ENOENT') storageError = true; }
  const files = () => {
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid sample directory');
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return readdirSync(directory).filter(name => namePattern.test(name)).filter(name => {
      const stat = lstatSync(join(directory, name)); return stat.isFile() && !stat.isSymbolicLink();
    }).sort();
  };
  const prune = () => {
    const rows = files();
    for (let index = 0; index < rows.length; index++) {
      const name = rows[index];
      if (Number(name.slice(0, 13)) < now() - MAX_AGE_MS || index < rows.length - MAX_COUNT) unlinkSync(join(directory, name));
    }
  };
  const store = {
    status() {
      let count = 0;
      try { prune(); count = files().length; } catch { storageError = true; }
      return { enabled, directory, count, max_count: MAX_COUNT, max_age_days: 7, max_bytes: MAX_BYTES, storage_error: storageError };
    },
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new Error('Invalid diagnostic preference');
      atomicState(settingsFile, { capture_failed_output: value });
      enabled = value; storageError = false; return store.status();
    },
    begin(callId) {
      // A running call is never captured retroactively when the switch is enabled.
      const optedIn = enabled;
      const blocks = new Map();
      let bytes = 0, clipped = false;
      const replace = (index, text, closed) => {
        const previous = blocks.get(index);
        if (previous?.closed) return;
        const remaining = MAX_BYTES - bytes + (previous?.bytes || 0);
        const limited = truncate(text, remaining), size = Buffer.byteLength(limited);
        if (Buffer.byteLength(text) > remaining) clipped = true;
        bytes += size - (previous?.bytes || 0); blocks.set(index, { text: limited, bytes: size, closed });
      };
      return {
        observe(chunk) {
          if (!optedIn || !enabled) { blocks.clear(); bytes = 0; return; }
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') replace(chunk.index, (blocks.get(chunk.index)?.text || '') + chunk.text, false);
          if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') replace(chunk.index, chunk.block.text, true);
        },
        finish({ failed, cancelled, complete }) {
          try {
            if (!optedIn || !enabled || !failed || cancelled || !idPattern.test(callId) || !bytes) return null;
            let text = redact([...blocks.values()].map(block => block.text).join(''));
            const payload = { call_id: callId, captured_at: new Date(now()).toISOString(), output_complete: !!complete, truncated: clipped, final_text: '' };
            // JSON escaping expands some characters. Bound the entire file, not only its text.
            let body;
            for (;;) {
              payload.final_text = text; body = JSON.stringify(payload);
              const excess = Buffer.byteLength(body) - MAX_BYTES;
              if (excess <= 0) break;
              text = truncate(text, Buffer.byteLength(text) - Math.max(1, excess)); payload.truncated = true;
            }
            mkdirSync(directory, { recursive: true }); files();
            writeFileSync(join(directory, `${now()}-${callId}.json`), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            prune(); storageError = false; return callId;
          } catch { storageError = true; return null; }
          finally { blocks.clear(); bytes = 0; }
        },
      };
    },
  };
  // Expiration is also enforced while DSH is idle through regular public status reads.
  store.status(); return store;
}
