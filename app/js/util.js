// Shared helpers: DOM building, API calls, formatting, dialogs, menus and app state.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ state

export const S = {
  ollama: { running: false, endpoint: '', version: '' },
  hardware: { gpu: '', vram: 0, ram: 0 },
  settings: {},
  projects: [],
  project: null,
  models: [],
  blocked: [],
  running: [],
  chats: [],
  chat: null,
  sidebarTab: 'chats',
};

const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

// ------------------------------------------------------------------ API

export async function api(path, { method, body, query, signal, stream } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.set(k, v);
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const init = { method: method || (body !== undefined ? 'POST' : 'GET'), signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, init); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Hearth\'s local service is not responding.');
  }
  if (!res.ok) {
    let msg = 'Request failed (' + res.status + ').';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (stream) return res;
  return res.json();
}

/** Reads a newline-delimited JSON stream, yielding one object per line. */
export async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { yield JSON.parse(line); } catch {} }
    }
  }
  const rest = buf.trim();
  if (rest) { try { yield JSON.parse(rest); } catch {} }
}

// ------------------------------------------------------------------ formatting

export function fmtBytes(n) {
  if (!n || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i < 2 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

/** Memory sizes the way Windows and hardware vendors state them (16 GB of VRAM, 32 GB of RAM). */
export function fmtMem(n) {
  if (!n) return '';
  const gb = n / 1073741824;
  return (gb >= 10 ? Math.round(gb) : gb.toFixed(1)) + ' GB';
}

export function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

export function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid(prefix) {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + '_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function dayGroup(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 864e5) return 'Yesterday';
  if (ts >= start - 6 * 864e5) return 'This week';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleString(undefined, { month: 'long' });
  return String(d.getFullYear());
}

export function baseName(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
export function dirName(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

/** How well a model of a given size will run on this PC. */
export function fitFor(bytes) {
  const { vram, ram } = S.hardware;
  if (!bytes || !vram) return null;
  const need = bytes * 1.12 + 0.8e9;
  if (need <= vram) return { kind: 'ok', label: 'Fits your GPU', title: 'Should run fully on your GPU.' };
  if (need <= vram + ram * 0.55) return { kind: 'warn', label: 'GPU + RAM', title: 'Larger than your GPU memory, so part of it will run from system RAM and be slower.' };
  return { kind: 'danger', label: 'Too large', title: 'Larger than this PC\'s GPU and system memory can comfortably hold.' };
}

// ------------------------------------------------------------------ toasts

export function toast(message, kind = 'ok', ms = 4200) {
  const el = h('div', { class: 'toast ' + kind }, icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'alert'), h('div', null, message));
  $('#toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }, ms);
}
export const fail = (e) => { if (e && e.name !== 'AbortError') toast(e.message || String(e), 'error', 6500); };

// ------------------------------------------------------------------ popovers & menus

let openPop = null;
export function closePop() { if (openPop) { openPop.close(); } }

/** Shows `content` anchored to an element or a point. Closes on outside click or Escape. */
export function popover(anchor, content, { align = 'left', cls = '', gap = 6 } = {}) {
  closePop();
  const pop = h('div', { class: 'pop ' + cls }, content);
  $('#layer').append(pop);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = align === 'right' ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = r.bottom + gap;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - gap - ph);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const onDown = (e) => { if (!pop.contains(e.target)) api_.close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); api_.close(); } };
  const api_ = {
    el: pop,
    close() {
      if (openPop !== api_) return;
      openPop = null;
      pop.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    },
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  openPop = api_;
  return api_;
}

/** items: {label, icon, onClick, danger, disabled} | 'sep' | {note} */
export function menu(anchor, items, opts) {
  const box = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { box.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.note) { box.append(h('div', { class: 'menu-note' }, it.note)); continue; }
    box.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''), disabled: !!it.disabled,
      onClick: () => { closePop(); it.onClick && it.onClick(); },
    }, it.icon ? icon(it.icon) : null, it.label));
  }
  return popover(anchor, box, opts);
}

// ------------------------------------------------------------------ modals

export function modal({ title, body, foot, size = '', onClose }) {
  const scrim = h('div', { class: 'scrim' });
  const closeBtn = h('button', { class: 'iconbtn', title: 'Close', onClick: () => ctl.close() }, icon('x'));
  const box = h('div', { class: 'modal ' + size, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn),
    body,
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  scrim.append(box);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.pop')) { e.stopPropagation(); ctl.close(); } };
  const ctl = {
    el: box,
    close() {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    },
  };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) ctl.close(); });
  document.addEventListener('keydown', onKey);
  $('#layer').append(scrim);
  const first = box.querySelector('[autofocus], .modal-body input, .modal-body textarea');
  if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
  return ctl;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; m.close(); resolve(v); };
    const m = modal({
      title,
      body: h('div', { class: 'modal-body' }, typeof message === 'string' ? h('div', { class: 'muted' }, message) : message),
      foot: [
        h('button', { class: 'btn ghost', onClick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => done(true) }, confirmLabel),
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', hint, selectStem = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { class: 'input', value, placeholder, spellcheck: false });
    const done = (v) => { answered = true; m.close(); resolve(v); };
    const submit = () => { const v = input.value.trim(); if (v) done(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const m = modal({
      title,
      body: h('div', { class: 'modal-body' }, h('div', { class: 'field' }, label ? h('label', null, label) : null, input, hint ? h('div', { class: 'hint' }, hint) : null)),
      foot: [
        h('button', { class: 'btn ghost', onClick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: submit }, confirmLabel),
      ],
      onClose: () => { if (!answered) resolve(null); },
    });
    if (selectStem && value) {
      setTimeout(() => { const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 40);
    }
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}
