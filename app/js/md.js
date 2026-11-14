// Small, dependency-free Markdown renderer and syntax highlighter.
// Everything is HTML-escaped first; only the tags produced here ever reach the page.

import { esc } from './util.js';

// ------------------------------------------------------------------ highlighting

const KEYWORDS = new Set((
  'abstract as async await break case catch class const continue def default defer delete do elif else enum except export ' +
  'extends final finally fn for foreach from func function go if impl implements import in instanceof interface internal is ' +
  'lambda let loop match mod mut namespace new not or and override package pass private protected pub public raise readonly ' +
  'ref return self sealed static struct super switch then this throw trait try type typeof unsafe use using var virtual void ' +
  'when where while with yield select insert update create alter drop table into values join left right inner outer group by ' +
  'order having limit union distinct echo fi done esac elseif end begin local param'
).split(' '));
const LITERALS = new Set('true false null nil none undefined nan True False None NULL TRUE FALSE'.split(' '));

const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|console|ps1|powershell|pwsh|yaml|yml|toml|rb|ruby|r|dockerfile|makefile|make|ini|conf|cfg|perl|pl|elixir|ex|nim|tcl|gitignore|env|properties|julia|jl)$/;
const DASH_LANGS = /^(sql|lua|hs|haskell|ada|elm|plsql|pgsql|mysql|sqlite)$/;
const MARKUP_LANGS = /^(html|htm|xml|svg|vue|xaml|csproj|plist)$/;
const SLASH_LANGS = /^(js|javascript|jsx|ts|typescript|tsx|mjs|cjs|c|h|cpp|cc|cxx|hpp|cs|csharp|java|kt|kotlin|go|golang|rs|rust|swift|php|dart|scala|json|jsonc|json5|groovy|gradle|objc|m|zig|v|proto|glsl|hlsl|scss|less|sass)$/;

const EXT_LANG = {
  mjs: 'js', cjs: 'js', pyw: 'py', htm: 'html', yml: 'yaml', psm1: 'ps1', psd1: 'ps1', bat: 'sh', cmd: 'sh',
  hpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'c', kts: 'kt', markdown: 'md', csproj: 'xml', props: 'xml', targets: 'xml',
};
export function langForFile(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return EXT_LANG[ext] || ext;
}

export function highlight(code, lang) {
  lang = (lang || '').toLowerCase();
  if (code.length > 150000) return esc(code);
  if (MARKUP_LANGS.test(lang)) return highlightMarkup(code);
  const css = lang === 'css';
  const hash = HASH_LANGS.test(lang);
  const dash = DASH_LANGS.test(lang);
  const slash = SLASH_LANGS.test(lang);
  if (!css && !hash && !dash && !slash) return esc(code);

  const parts = [];
  if (slash || css) parts.push('(?<com>\\/\\*[\\s\\S]*?(?:\\*\\/|$)' + (slash ? '|\\/\\/[^\\n]*' : '') + ')');
  else if (hash) parts.push('(?<com>#[^\\n]*)');
  else if (dash) parts.push('(?<com>--[^\\n]*)');
  parts.push('(?<str>"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?|`(?:\\\\.|[^`\\\\])*`?)');
  parts.push('(?<num>\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)');
  parts.push('(?<id>[A-Za-z_$][\\w$]*)');
  const re = new RegExp(parts.join('|'), 'g');

  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    const g = m.groups;
    if (g.com != null) out += '<span class="t-com">' + esc(m[0]) + '</span>';
    else if (g.str != null) out += '<span class="t-str">' + esc(m[0]) + '</span>';
    else if (g.num != null) out += '<span class="t-num">' + esc(m[0]) + '</span>';
    else {
      const w = m[0];
      if (KEYWORDS.has(w) || (dash && KEYWORDS.has(w.toLowerCase()))) out += '<span class="t-kw">' + esc(w) + '</span>';
      else if (LITERALS.has(w)) out += '<span class="t-num">' + esc(w) + '</span>';
      else if (code[last] === '(') out += '<span class="t-fn">' + esc(w) + '</span>';
      else if (/^[A-Z][A-Za-z0-9]*[a-z]/.test(w)) out += '<span class="t-type">' + esc(w) + '</span>';
      else out += esc(w);
    }
  }
  return out + esc(code.slice(last));
}

function highlightMarkup(code) {
  const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[A-Za-z][\w:.-]*)|("[^"\n]*"|'[^'\n]*')|(\/?>)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) out += '<span class="t-com">' + esc(m[0]) + '</span>';
    else if (m[2] || m[4]) out += '<span class="t-tag">' + esc(m[0]) + '</span>';
    else out += '<span class="t-str">' + esc(m[0]) + '</span>';
  }
  return out + esc(code.slice(last));
}

// ------------------------------------------------------------------ markdown

const RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return blocks(lines);
}

function indentOf(line) { return line.length - line.trimStart().length; }

function blocks(lines) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(RE_FENCE);
    if (m) {
      const indent = m[1].length, ch = m[2][0], len = m[2].length, lang = m[3];
      const buf = [];
      i++;
      while (i < n) {
        const t = lines[i].trim();
        if (t.length >= len && t === ch.repeat(t.length) ) { i++; break; }
        buf.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      out.push(codeBlock(buf.join('\n'), lang));
      continue;
    }

    m = line.match(RE_HEADING);
    if (m) { const lvl = m[1].length; out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i++; continue; }

    if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < n && RE_QUOTE.test(lines[i])) { buf.push(lines[i].match(RE_QUOTE)[1]); i++; }
      out.push('<blockquote>' + blocks(buf) + '</blockquote>');
      continue;
    }

    if (line.includes('|') && i + 1 < n && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < n && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push('<table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] || '', k)).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }

    if (RE_LIST.test(line)) { i = list(lines, i, out); continue; }

    // paragraph
    const buf = [line.trim()];
    i++;
    while (i < n) {
      const l = lines[i];
      if (!l.trim() || RE_FENCE.test(l) || RE_HEADING.test(l) || RE_HR.test(l) || RE_QUOTE.test(l)) break;
      const lm = l.match(RE_LIST);
      if (lm && (!/\d/.test(lm[2]) || /^1[.)]$/.test(lm[2]))) break;
      if (l.includes('|') && i + 1 < n && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) break;
      buf.push(l.trim());
      i++;
    }
    out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
  }
  return out.join('');
}

function cells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function list(lines, i, out) {
  const n = lines.length;
  const first = lines[i].match(RE_LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;

  while (i < n) {
    const m = lines[i].match(RE_LIST);
    if (!m || Math.abs(m[1].length - base) > 1 || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const buf = [m[3]];
    i++;
    while (i < n) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < n && !lines[j].trim()) j++;
        if (j < n && indentOf(lines[j]) > base + 1) { buf.push(''); i++; continue; }
        break;
      }
      if (indentOf(l) > base + 1) { buf.push(l.slice(Math.min(indentOf(l), contentIndent))); i++; continue; }
      break;
    }
    items.push(buf);
    // blank line(s) between sibling items
    let j = i;
    while (j < n && !lines[j].trim()) j++;
    if (j > i && j < n) {
      const nm = lines[j].match(RE_LIST);
      if (nm && Math.abs(nm[1].length - base) <= 1 && /\d/.test(nm[2]) === ordered) { loose = true; i = j; }
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const html = items.map((buf) => {
    let inner = blocks(buf);
    if (!loose) {
      const mm = inner.match(/^<p>([\s\S]*?)<\/p>([\s\S]*)$/);
      if (mm && !mm[1].includes('<p>')) inner = mm[1] + mm[2];
    }
    const task = inner.match(/^(<p>)?\[( |x|X)\]\s+/);
    if (task) inner = inner.replace(/^(<p>)?\[( |x|X)\]\s+/, (_, p, c) => (p || '') + `<input type="checkbox" disabled${c === ' ' ? '' : ' checked'}> `);
    return '<li>' + inner + '</li>';
  }).join('');
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${html}</${tag}>`);
  return i;
}

function codeBlock(code, lang) {
  return '<div class="codeblock"><div class="codeblock-head"><span>' + esc(lang || 'text') +
    '</span><button type="button" data-copy-code>Copy</button></div><pre><code>' + highlight(code, lang) + '</code></pre></div>';
}

function inline(text) {
  const codes = [];
  let s = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, t, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m0, label, url) =>
    /^(https?:\/\/|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?![\w_])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => '<code>' + esc(codes[+k].trim() || codes[+k]) + '</code>');
  return s;
}
