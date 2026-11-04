import { fail } from './runtime-api.js';
import { sensitiveText } from './proactive-drafts.js';

const invalid = () => fail('life_inspiration_invalid', '研究问题只保留抽象启发，不含私聊原文、身份、链接、文件路径或凭证。');
const clean = value => typeof value === 'string' ? value.trim() : '';
const privateReference = text => sensitiveText(text) || /(?:https?:\/\/|(?:[A-Za-z]:[\\/]|\\\\)|@[\w\u4e00-\u9fff]|[“”「」『』]|(?:我|你)(?:们|的|家)|提督|主人|老板|身份证|住址|电话号码|会话编号)/u.test(text);

/** A narrow question, not permission to export the dialogue that inspired it. */
export function validateResearchInspiration(value, events = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['question', 'keywords'].includes(k)) ||
      !clean(value.question) || value.question.length > 240 || !Array.isArray(value.keywords) || value.keywords.length > 5 ||
      value.keywords.some(k => !clean(k) || k.length > 40)) throw invalid();
  const question = clean(value.question), keywords = [...new Set(value.keywords.map(clean))];
  if (privateReference([question, ...keywords].join('\n'))) throw invalid();
  // Reject copied sentences rather than treating a truncated raw message as a
  // public summary. Semantic abstraction is additionally required by the tool.
  const compact = text => String(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const proposed = compact([question, ...keywords].join(' '));
  for (const event of events) {
    const source = compact(String(event.summary || '').replace(/^(?:用户说|伙伴已表达)：/, ''));
    for (let start = 0; start + 16 <= source.length; start++) {
      if (proposed.includes(source.slice(start, start + 16))) throw invalid();
    }
  }
  return { question, keywords };
}
