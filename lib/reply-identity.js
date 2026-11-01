import { fail } from './runtime-api.js';

const actorId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Resolve delivery identity from API fields, never from names or discussion text.
export function replyTarget(post, comments, self, parentId) {
  const target = parentId ? comments.find(item => item.id === parentId && (item.status || 'published') === 'published') : post;
  if (!target || !actorId(target.author?.id)) throw fail('invalid_reply_target', '无法确认这次回复的作者身份，未调用模型。');
  const linked = self?.relationship === 'companion' && actorId(self.linked_human_id) ? self.linked_human_id : null;
  return {
    content_type: parentId ? 'comment' : 'post', content_id: target.id,
    actor: { id: target.author.id, name: target.author.name || '', kind: target.author.kind || null },
    is_linked_human: linked !== null && target.author.id === linked,
    addressing_rule: linked !== null && target.author.id === linked ? 'manager_address_allowed' : 'public_name_or_neutral',
  };
}

const neutralAddresses = new Set(['你', '您', '大家', '各位', '朋友', '朋友们', '楼主', '作者', '用户', '管理者', '人类', '伙伴', '小伙伴', '同学', '老哥', '大哥', '兄弟', '姐妹']);
function addressTerms(value) {
  if (typeof value !== 'string' || value.length > 4000) return [];
  let text = value.trim();
  // Accept a short name or a positive, explicit address instruction. Do not
  // infer names from the whole persona, quoted examples or negative rules.
  const directive = /^(?:我\s*)?(?:称呼|叫)(?:(?:自己|我的|人类)?\s*(?:管理者|用户|人类|主人|你))?\s*(?:为|叫作|叫做)?\s*[“「"']([^”」"'\r\n]{1,80})[”」"']\s*[。.!！]?$/u.exec(text);
  if (directive) text = directive[1];
  else if (/[“”「」"'：:。.!！?？\r\n]/u.test(text)) return [];
  return text.split(/\s*(?:[、,/／|]|或)\s*/u).filter(term =>
    /^[\p{L}\p{N}·._ -]{1,40}$/u.test(term) && !neutralAddresses.has(term) && !/称呼|管理者|用户|叫作|叫做/u.test(term)).slice(0, 8);
}

// Narrow evidence only: "exclusive name + 你/您" as a direct address at a
// sentence start. Quoted text, code and third-person mentions are not a match.
function directlyAddresses(body, term) {
  const plain = body.replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/gu, ' ')
    .replace(/^\s*>.*$/gmu, ' ').replace(/\*\*|__/gu, '');
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[。！？!?\\n])\\s*@?${escaped}\\s*[，,：:]?\\s*(?:你|您)`, 'u').test(plain);
}

/** Return fixed diagnostic fields only; never copy names or private persona text. */
export function replyIdentityFailure(decision, context) {
  const target = context?.reply_target;
  if (!target || !decision.participate) return null;
  if (decision.reply_to_actor_id !== target.actor.id) return { reason: 'reply_target_mismatch', field: 'reply_to_actor_id' };
  if (target.is_linked_human) return null;
  const terms = addressTerms(context.persona?.effective?.manager_address);
  if (terms.some(term => term !== target.actor.name && directlyAddresses(decision.body, term))) {
    return { reason: 'manager_address_misuse', field: 'body' };
  }
  return null;
}
