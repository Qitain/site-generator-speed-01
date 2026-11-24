// makefun-site compatible static site generator - optimized implementation
import { setFlagsFromString } from 'node:v8';

// Defer costly optimizing compilations beyond these bounded site builds.
setFlagsFromString('--invocation-count-for-turbofan=1000000');

const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL_RE = /[\\`*\[]/g;

function byCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function readingMinutes(text) {
  // Count groups of up to 200 words instead of allocating or visiting every word.
  const groups = text.match(/\S+(?:\s+\S+){0,199}/g);
  return groups === null ? 1 : groups.length;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_SPECIAL_RE = /[&<>"']/;
const escapedChar = c => ESCAPES[c];
function escapeHtml(text) {
  return HTML_SPECIAL_RE.test(text) ? text.replace(/[&<>"']/g, escapedChar) : text;
}

function slugify(text) {
  const slug = text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '').toLowerCase();
  return slug === '' ? 'untitled' : slug;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (!inner.includes('\\')) return inner.includes('"') ? { error: 'a quoted string holds a stray quote' } : { value: inner };
    if (/^(?:[^"\\]|\\["\\])*$/.test(inner)) return { value: inner.replace(/\\(["\\])/g, '$1') };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map(t => t.trim());
      if (tags.some(t => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let close = text.indexOf('\n---', 3);
  while (close !== -1 && close + 4 !== text.length && text[close + 4] !== '\n') {
    close = text.indexOf('\n---', close + 1);
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const lines = text.slice(0, close).split('\n');
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(close + 5) };
}

function headingOf(line) {
  if (line[0] !== '#') return null;
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  const first = line[0];
  return BLANK_RE.test(line) || (first === '`' && FENCE_OPEN_RE.test(line)) || headingOf(line) !== null || ((first === '-' || first === '*') && HR_RE.test(line));
}

function trimLine(line) {
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(line.length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9 &&
      last !== 13 && last !== 0x2028 && last !== 0x2029) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let p = j;
    while (p > from && s[p - 1] === '\\') p--;
    if ((j - p) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let p = j;
    while (p > from && s[p - 1] === '\\') p--;
    if ((j - p) % 2 !== 0) j = s.indexOf('*', j + 1);
    else if (s[j + 1] === '*') j = s.indexOf('*', j + 2);
    else return j;
  }
  return -1;
}

function inlineBackslash(s, i, env) {
  const next = s[i + 1];
  if (next !== undefined && ESCAPABLE.has(next)) {
    env.inlineEnd = i + 2;
    return next === '>' ? '&gt;' : next;
  }
  env.inlineEnd = i + 1;
  return '\\';
}

function inlineCode(s, i, env) {
  const j = s.indexOf('`', i + 1);
  if (j > i + 1) {
    env.inlineEnd = j + 1;
    return `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
  }
  env.inlineEnd = i + 1;
  return '`';
}

function inlineStrong(s, i, env) {
  const j = findUnescaped(s, '**', i + 2);
  if (j > i + 2) {
    const html = inline(s.slice(i + 2, j), env);
    env.inlineEnd = j + 2;
    return `<strong>${html}</strong>`;
  }
  env.inlineEnd = i + 2;
  return '**';
}

function inlineEm(s, i, env) {
  const j = findSingleStar(s, i + 1);
  if (j > i + 1) {
    const html = inline(s.slice(i + 1, j), env);
    env.inlineEnd = j + 1;
    return `<em>${html}</em>`;
  }
  env.inlineEnd = i + 1;
  return '*';
}

function inlineStar(s, i, env) {
  return s[i + 1] === '*' ? inlineStrong(s, i, env) : inlineEm(s, i, env);
}

function inlineLink(s, i, env) {
  const k = findUnescaped(s, ']', i + 1);
  const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
  const target = m === -1 ? '' : s.slice(k + 2, m);
  if (target !== '' && !/\s/.test(target)) {
    const href = escapeHtml(env.link(target));
    const label = inline(s.slice(i + 1, k), env);
    env.inlineEnd = m + 1;
    return `<a href="${href}">${label}</a>`;
  }
  env.inlineEnd = i + 1;
  return '[';
}

const INLINE_HANDLERS = [];
INLINE_HANDLERS[92] = inlineBackslash;
INLINE_HANDLERS[96] = inlineCode;
INLINE_HANDLERS[42] = inlineStar;
INLINE_HANDLERS[91] = inlineLink;

function inline(s, env) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    INLINE_SPECIAL_RE.lastIndex = i;
    const next = INLINE_SPECIAL_RE.exec(s);
    if (next === null) return out + escapeHtml(s.slice(i));
    if (next.index > i) out += escapeHtml(s.slice(i, next.index));
    i = next.index;
    out += INLINE_HANDLERS[s.charCodeAt(i)](s, i, env);
    i = env.inlineEnd;
  }
  return out;
}

function blankMarkdownLine(line) {
  const first = line.charCodeAt(0);
  return line.length === 0 || ((first === 32 || first === 9 || first === 13 || first === 0x2028 || first === 0x2029) && BLANK_RE.test(line));
}

function trimMarkdownLine(line) {
  const length = line.length;
  const first = line.charCodeAt(0), last = line.charCodeAt(length - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  let start = 0, end = length;
  while (start < length) {
    const c = line.charCodeAt(start);
    if (c !== 32 && c !== 9) break;
    start++;
  }
  while (end > start) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return line.slice(start, end);
}

function markdownCode(state) {
  const { lines, blocks } = state;
  const lang = state.fence[1];
  state.fence = null;
  const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
  const begin = state.index + 1;
  let i = begin;
  while (i < lines.length && (lines[i][0] !== '`' || !FENCE_CLOSE_RE.test(lines[i]))) i++;
  const body = begin === i ? '' : lines.slice(begin, i).join('\n') + '\n';
  blocks.push(`<pre><code${cls}>${escapeHtml(body)}</code></pre>\n`);
  state.index = i + 1;
}

function markdownHeading(state) {
  const heading = state.heading;
  state.heading = null;
  const id = uniqueSlug(slugify(heading.text), state.ids);
  const content = inline(heading.text, state.env);
  state.blocks.push(`<h${heading.depth} id="${id}">${content}</h${heading.depth}>\n`);
  if (heading.depth === 2 || heading.depth === 3) state.toc.push({ level: heading.depth, id, html: content });
  state.index++;
}

function markdownRule(state) {
  state.blocks.push('<hr>\n');
  state.index++;
}

function markdownQuote(state) {
  const { lines, blocks, env } = state;
  const parts = [];
  let i = state.index;
  while (i < lines.length && lines[i][0] === '>') {
    const raw = lines[i++];
    const part = trimMarkdownLine(raw.slice(raw[1] === ' ' ? 2 : 1));
    if (part !== '') parts.push(part);
  }
  blocks.push(parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>\n`);
  state.index = i;
}

function markdownList(state) {
  const { lines, blocks, env } = state;
  const isOrdered = state.ordered !== null;
  const marker = isOrdered ? ORDERED_RE : BULLET_RE;
  const tag = isOrdered ? 'ol' : 'ul';
  const start = isOrdered ? Number(state.ordered[1]) : 1;
  blocks.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
  let match = state.bullet ?? state.ordered;
  state.bullet = state.ordered = null;
  let i = state.index;
  while (match !== null) {
    const parts = [trimMarkdownLine(isOrdered ? match[2] : match[1])];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const first = next[0];
      match = isOrdered ? (first >= '0' && first <= '9' ? marker.exec(next) : null) : ((first === '-' || first === '*') ? marker.exec(next) : null);
      if (match !== null || first !== ' ' || next[1] !== ' ' || !CONTINUED_RE.test(next)) break;
      parts.push(trimMarkdownLine(lines[i++]));
    }
    blocks.push(`<li>${inline(parts.length === 1 ? parts[0] : parts.join('\n'), env)}</li>\n`);
    if (i === lines.length) break;
  }
  blocks.push(`</${tag}>\n`);
  state.index = i;
}

function markdownParagraph(state) {
  const { lines, env } = state;
  let i = state.index;
  const parts = [trimMarkdownLine(lines[i++])];
  while (i < lines.length) {
    const next = lines[i];
    const first = next[0];
    if (blankMarkdownLine(next)) break;
    if (first === '`') {
      state.fence = FENCE_OPEN_RE.exec(next);
      if (state.fence !== null) break;
    }
    if (first === '#') {
      state.heading = headingOf(next);
      if (state.heading !== null) break;
    }
    if ((first === '-' || first === '*') && HR_RE.test(next)) break;
    parts.push(trimMarkdownLine(next));
    i++;
  }
  const content = inline(parts.length === 1 ? parts[0] : parts.join('\n'), env);
  if (state.excerpt === null) state.excerpt = content;
  state.blocks.push(`<p>${content}</p>\n`);
  state.index = i;
}

const MARKDOWN_HANDLERS = [markdownCode, markdownHeading, markdownRule, markdownQuote, markdownList, markdownParagraph];

function renderMarkdown(src, env) {
  const state = {
    lines: src.split('\n'), env, ids: new Set(), toc: [], blocks: [], index: 0,
    excerpt: null, heading: null, fence: null, bullet: null, ordered: null
  };
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    const first = line[0];
    if (blankMarkdownLine(line)) { state.index++; continue; }
    let kind = 5;
    state.fence = state.fence ?? (first === '`' ? FENCE_OPEN_RE.exec(line) : null);
    if (state.fence !== null) kind = 0;
    else {
      state.heading = state.heading ?? headingOf(line);
      if (state.heading !== null) kind = 1;
      else if ((first === '-' || first === '*') && HR_RE.test(line)) kind = 2;
      else if (first === '>') kind = 3;
      else {
        state.bullet = first === '-' || first === '*' ? BULLET_RE.exec(line) : null;
        state.ordered = state.bullet === null && first >= '0' && first <= '9' ? ORDERED_RE.exec(line) : null;
        if (state.bullet !== null || state.ordered !== null) kind = 4;
      }
    }
    MARKDOWN_HANDLERS[kind](state);
  }
  return { html: state.blocks.join(''), toc: state.toc, excerpt: state.excerpt ?? '' };
}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new Error(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new Error(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new Error(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new Error(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new Error(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new Error(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new Error(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function getOwn(value, key) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function templateDependencies(asts) {
  const dependencies = new Map([...asts.keys()].map(name => [name, new Set()]));
  let changed;
  do {
    changed = false;
    for (const [name, nodes] of asts) {
      const roots = dependencies.get(name);
      const add = (root, bound) => {
        if (!bound.has(root) && !roots.has(root)) { roots.add(root); changed = true; }
      };
      const visit = (body, bound) => {
        for (const node of body) {
          if (node.path !== undefined) add(node.path[0], bound);
          if (node.kind === 'for') {
            const inner = new Set(bound);
            inner.add(node.name); inner.add('loop');
            visit(node.body, inner);
          } else if (node.kind === 'if') {
            visit(node.then, bound);
            if (node.else !== null) visit(node.else, bound);
          } else if (node.kind === 'include') {
            for (const root of dependencies.get(node.name) ?? []) add(root, bound);
          }
        }
      };
      visit(nodes, new Set());
    }
  } while (changed);
  return dependencies;
}

function memoTemplate(render, roots) {
  // Only loop metadata is mutated during rendering. All other roots are immutable.
  if (roots.has('loop')) return render;
  const keys = [...roots];
  const depths = [];
  if (keys.length === 0) return (scope, ctx, depth) => {
    if (depths[depth] === undefined) depths[depth] = render(scope, ctx, depth);
    return depths[depth];
  };
  return (scope, ctx, depth) => {
    let cache = depths[depth];
    if (cache === undefined) depths[depth] = cache = new Map();
    for (let i = 0; i < keys.length - 1; i++) {
      const key = scope[keys[i]];
      let next = cache.get(key);
      if (next === undefined) cache.set(key, next = new Map());
      cache = next;
    }
    const key = scope[keys[keys.length - 1]];
    let html = cache.get(key);
    if (html === undefined) { html = render(scope, ctx, depth); cache.set(key, html); }
    return html;
  };
}

function compileTemplate(nodes) {
  let serial = 0;
  const top = { bindings: new Map(), roots: new Map(), values: new Map(), texts: new Map(), prelude: [], scope: 'scope' };
  const includes = new WeakMap();
  const hasInclude = body => {
    if (includes.has(body)) return includes.get(body);
    const found = body.some(n => n.kind === 'include' ||
      (n.kind === 'for' && hasInclude(n.body)) ||
      (n.kind === 'if' && (hasInclude(n.then) || (n.else !== null && hasInclude(n.else)))));
    includes.set(body, found);
    return found;
  };
  const bindingOf = (frame, root) => {
    let binding = frame.bindings.get(root);
    if (binding !== undefined) return binding;
    binding = top.roots.get(root);
    if (binding === undefined) {
      binding = { frame: top, expr: `r${serial++}` };
      top.roots.set(root, binding);
    }
    return binding;
  };
  const valueOf = (frame, path) => {
    const binding = bindingOf(frame, path[0]);
    const owner = binding.frame;
    const key = path.join('.');
    let value = owner.values.get(key);
    if (value !== undefined) return value;
    let code = binding.expr;
    let from = 1;
    if (binding.meta !== undefined) {
      if (path.length > 1 && Object.hasOwn(binding.meta, path[1])) {
        code = binding.meta[path[1]];
        from = 2;
      } else binding.object = true;
    }
    for (let i = from; i < path.length; i++) code = `getOwn(${code},${JSON.stringify(path[i])})`;
    value = `v${serial++}`;
    owner.values.set(key, value);
    owner.prelude.push(`const ${value}=${code};\n`);
    return value;
  };
  const textValue = (frame, path, escaped) => {
    const binding = bindingOf(frame, path[0]);
    const owner = binding.frame;
    const key = path.join('.');
    let text = owner.texts.get(key);
    if (text === undefined) {
      text = { raw: `t${serial++}` };
      owner.texts.set(key, text);
      const value = valueOf(frame, path);
      owner.prelude.push(`const ${text.raw}=textOf(${value});\n`);
    }
    if (!escaped) return text.raw;
    if (text.escaped === undefined) {
      text.escaped = `e${serial++}`;
      owner.prelude.push(`const ${text.escaped}=escapeHtml(${text.raw});\n`);
    }
    return text.escaped;
  };
  const emit = (body, frame) => {
    let code = '';
    let parts = [];
    const flush = () => {
      if (parts.length > 0) code += `out+=${parts.join('+')};\n`;
      parts = [];
    };
    for (const n of body) {
      if (n.kind === 'text') parts.push(JSON.stringify(n.text));
      else if (n.kind === 'var' || n.kind === 'raw') parts.push(textValue(frame, n.path, n.kind === 'var'));
      else {
        flush();
        if (n.kind === 'if') {
          const condition = valueOf(frame, n.path);
          const yes = emit(n.then, frame);
          const no = n.else === null ? null : emit(n.else, frame);
          code += `if(${n.not ? '!' : ''}truthy(${condition})){\n${yes}}`;
          if (no !== null) code += `else{\n${no}}`;
          code += '\n';
        } else if (n.kind === 'for') {
          const collection = valueOf(frame, n.path);
          const id = serial++;
          const xs = `xs${id}`, inner = `s${id}`, loop = `l${id}`, k = `k${id}`, item = `x${id}`;
          const materialize = hasInclude(n.body);
          const child = { bindings: new Map(frame.bindings), values: new Map(), texts: new Map(), prelude: [], scope: materialize ? inner : frame.scope };
          const metadata = {
            frame: child, expr: loop, object: materialize,
            meta: { index: `${k}+1`, first: `${k}===0`, last: `${k}===${xs}.length-1`, length: `${xs}.length` }
          };
          child.bindings.set(n.name, { frame: child, expr: item });
          child.bindings.set('loop', metadata);
          const content = emit(n.body, child);
          code += `{const ${xs}=${collection};if(Array.isArray(${xs})){\n`;
          if (metadata.object) code += `const ${loop}={index:0,first:false,last:false,length:${xs}.length};\n`;
          if (materialize) code += `const ${inner}=Object.create(${frame.scope});${inner}[${JSON.stringify(n.name)}]=undefined;${inner}.loop=${loop};\n`;
          code += `for(let ${k}=0;${k}<${xs}.length;${k}++){\n`;
          if (n.name !== 'loop') code += `const ${item}=${xs}[${k}];\n`;
          if (metadata.object) code += `${loop}.index=${k}+1;${loop}.first=${k}===0;${loop}.last=${k}===${xs}.length-1;\n`;
          if (materialize && n.name !== 'loop') code += `${inner}[${JSON.stringify(n.name)}]=${item};\n`;
          code += child.prelude.join('') + content + '}}}\n';
        } else if (n.kind === 'include') {
          code += `{if(depth<${INCLUDE_DEPTH}){const t=ctx.templates.get(${JSON.stringify(n.name)});if(t!==undefined)out+=t(${frame.scope},ctx,depth+1);}}\n`;
        }
      }
    }
    flush();
    return code;
  };
  const body = emit(nodes, top);
  let roots = '';
  for (const [name, binding] of top.roots) roots += `const ${binding.expr}=scope[${JSON.stringify(name)}];\n`;
  return new Function('getOwn', 'textOf', 'truthy', 'escapeHtml',
    `return function(scope,ctx,depth){"use strict";let out="";\n${roots}${top.prelude.join('')}${body}return out;}`
  )(getOwn, textOf, truthy, escapeHtml);
}

function ownTags(s) {
  const tags = s.data.tags ?? [];
  const seen = new Set();
  const out = [];
  for (const name of tags) {
    const slug = slugify(name);
    if (!seen.has(slug)) { seen.add(slug); out.push(name); }
  }
  return out;
}

export function run(input) {
  // Parse templates
  const templates = new Map();
  const asts = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof Error) report.push(err.message);
      else throw err;
    }
  }
  const dependencies = templateDependencies(asts);
  for (const [name, nodes] of asts) templates.set(name, (scope, ctx, depth) => {
    const render = memoTemplate(compileTemplate(nodes), dependencies.get(name));
    templates.set(name, render);
    return render(scope, ctx, depth);
  });

  // Read sources
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find(d => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks
  const base = input.site.base_url.replace(/\/+$/, '');
  const taken = new Map();
  const takenIn = dir => { if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : [])); return taken.get(dir); };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown
  const staticPaths = new Set(statics.map(f => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      inlineEnd: 0,
      link: target => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
    };
    const rendered = renderMarkdown(s.body, env);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  // Collections
  const posts = kept.filter(s => s.post).sort((a, b) => {
    const da = a.data.date, db = b.data.date;
    if (da > db) return -1;
    if (da < db) return 1;
    return byCodeUnits(a.slug, b.slug);
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  // Tags
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map(name => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts
  const cardOf = s => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingMinutes(s.body),
    tags: s.tagRefs.map(t => ({ name: t.name, slug: t.slug, url: t.url }))
  });
  const cards = new Map(posts.map(p => [p, cardOf(p)]));

  const linkOf = s => s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const tagOf = t => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(p => cards.get(p)) });
  const pageOf = s => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map(h => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(p => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : nodes(Object.assign(Object.create(null), { site, tags: allTags, recent, ...vars }), ctx, 0);
  };

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = k => k === 1 ? `${base}/` : `${base}/page/${k}/`;
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(p => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) }
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }

  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter(s => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;

  return output;
}
