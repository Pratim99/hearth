// Project files: the tree in the sidebar, guarded file operations, and the viewer/editor pane.

import { h, icon, api, S, emit, on, $, clear, toast, fail, menu, modal, confirmDialog, promptDialog, fmtBytes, baseName, dirName } from './util.js';
import { highlight, langForFile } from './md.js';

const trees = new Map();   // projectId -> { expanded:Set<string>, cache:Map<string, entries>, find:'' }
const panes = new Map();   // projectId -> { tabs:[], active:null, open:true }

function tree() {
  const id = S.project.id;
  if (!trees.has(id)) trees.set(id, { expanded: new Set(), cache: new Map(), find: '' });
  return trees.get(id);
}
function pane() {
  const id = S.project.id;
  if (!panes.has(id)) panes.set(id, { tabs: [], active: null, open: true });
  return panes.get(id);
}
const pid = () => S.project.id;

// ------------------------------------------------------------------ tree

let treeHost = null;

export function renderFilesTab(host) {
  treeHost = host;
  clear(host);
  const p = S.project;
  if (!p.path) {
    host.append(h('div', { class: 'empty-note' }, 'This project is not linked to a folder yet. Link one to browse, edit and attach its files.',
      h('div', null, h('button', { class: 'btn sm', onClick: () => emit('edit-project', p.id) }, icon('link', 'sm'), 'Link a folder'))));
    return;
  }
  if (p.missing) {
    host.append(h('div', { class: 'empty-note' }, 'The linked folder could not be found:', h('div', { class: 'mono', style: { margin: '6px 0' } }, p.path),
      h('button', { class: 'btn sm', onClick: () => emit('edit-project', p.id) }, 'Choose another folder')));
    return;
  }
  const st = tree();
  const find = h('input', { class: 'input', placeholder: 'Find a file…', value: st.find, spellcheck: false });
  const list = h('div', { class: 'tree-list' });
  let timer = 0;
  find.addEventListener('input', () => { st.find = find.value; clearTimeout(timer); timer = setTimeout(() => drawTree(list), 200); });
  host.append(
    h('div', { class: 'tree-tools' }, find,
      h('button', { class: 'iconbtn', title: 'New file', onClick: () => createItem('', false) }, icon('plus')),
      h('button', { class: 'iconbtn', title: 'New folder', onClick: () => createItem('', true) }, icon('folder')),
      h('button', { class: 'iconbtn', title: 'Refresh', onClick: () => refreshTree() }, icon('refresh'))),
    list);
  drawTree(list);
}

async function loadDir(path, force) {
  const st = tree();
  if (!force && st.cache.has(path)) return st.cache.get(path);
  const r = await api('/api/fs/list', { query: { project: pid(), path } });
  st.cache.set(path, r.entries);
  return r.entries;
}

export async function refreshTree() {
  if (!S.project || !S.project.path) return;
  const st = tree();
  const paths = ['', ...st.expanded];
  st.cache.clear();
  await Promise.all(paths.map((p) => loadDir(p, true).catch(() => { st.expanded.delete(p); })));
  if (treeHost && S.sidebarTab === 'files') { const list = treeHost.querySelector('.tree-list'); if (list) drawTree(list); }
}

let drawSeq = 0;
async function drawTree(list) {
  const st = tree();
  const my = ++drawSeq;
  const q = st.find.trim();
  try {
    if (q) {
      const r = await api('/api/fs/find', { query: { project: pid(), q } });
      if (my !== drawSeq) return;
      clear(list);
      if (!r.results.length) list.append(h('div', { class: 'empty-note' }, 'No files match "' + q + '".'));
      for (const f of r.results) {
        list.append(h('div', { class: 'tree-row', title: f.path, style: { paddingLeft: '8px', height: 'auto', padding: '4px 4px 4px 8px' },
          onClick: () => openFile(f.path),
          onContextmenu: (e) => { e.preventDefault(); entryMenu({ x: e.clientX, y: e.clientY }, { ...f, dir: false, locked: null }); } },
          icon('file', 'ficon'),
          h('div', { class: 'grow' }, h('div', { class: 'tname' }, f.name), h('div', { class: 'faint truncate', style: { fontSize: '11px' } }, dirName(f.path) || '(project root)'))));
      }
      return;
    }
    const frag = document.createDocumentFragment();
    await addDir(frag, '', 0);
    if (my !== drawSeq) return;
    clear(list).append(frag);
    const rootDrop = h('div', { class: 'tree-root-drop' });
    wireDrop(rootDrop, '');
    list.append(rootDrop);
    if (!st.cache.get('').length) rootDrop.append(h('div', { class: 'empty-note' }, 'This folder is empty.'));
  } catch (e) {
    if (my !== drawSeq) return;
    clear(list).append(h('div', { class: 'empty-note' }, e.message));
  }
}

async function addDir(parent, path, depth) {
  const st = tree();
  const entries = await loadDir(path);
  const active = pane().active;
  for (const e of entries) {
    const open = e.dir && st.expanded.has(e.path);
    const row = h('div', {
      class: 'tree-row' + (e.dir ? ' dir' : '') + (e.locked ? ' locked' : '') + (open ? ' open' : '') + (!e.dir && e.path === active ? ' on' : ''),
      style: { paddingLeft: 6 + depth * 14 + 'px' },
      title: e.locked ? 'Locked — ' + e.locked : e.path,
      draggable: !e.locked,
      onClick: () => {
        if (e.locked) { toast('Locked — ' + e.locked + '.', 'warn'); return; }
        if (e.dir) { st.expanded.has(e.path) ? st.expanded.delete(e.path) : st.expanded.add(e.path); drawTree(row.closest('.tree-list')); }
        else openFile(e.path);
      },
      onContextmenu: (ev) => { ev.preventDefault(); entryMenu({ x: ev.clientX, y: ev.clientY }, e); },
      onDragstart: (ev) => { ev.dataTransfer.setData('text/hearth-path', e.path); ev.dataTransfer.effectAllowed = 'move'; },
    },
      e.dir ? icon('chevron', 'chev') : h('span', { style: { width: '14px', flex: 'none' } }),
      icon(e.dir ? 'folder' : 'file', 'ficon'),
      h('span', { class: 'tname' }, e.name),
      e.locked ? icon('lock', 'lock sm') : null,
      h('button', { class: 'iconbtn item-more', title: 'More', onClick: (ev) => { ev.stopPropagation(); entryMenu(ev.currentTarget, e); } }, icon('more')));
    if (e.dir && !e.locked) wireDrop(row, e.path);
    parent.append(row);
    if (open) {
      try { await addDir(parent, e.path, depth + 1); }
      catch { st.expanded.delete(e.path); }
    }
  }
}

function wireDrop(el, targetDir) {
  el.addEventListener('dragover', (ev) => {
    if (![...ev.dataTransfer.types].includes('text/hearth-path')) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault(); el.classList.remove('drop');
    const from = ev.dataTransfer.getData('text/hearth-path');
    if (!from || dirName(from) === targetDir || from === targetDir) return;
    moveItem(from, targetDir);
  });
}

function entryMenu(anchor, e) {
  if (e.locked) {
    menu(anchor, [
      { note: 'Locked — ' + e.locked + '. Hearth will not open, change, move or delete it.' },
      e.userLocked ? 'sep' : null,
      e.userLocked ? { label: 'Remove protection', icon: 'unlock', onClick: () => setProtected(e, false) } : null,
    ]);
    return;
  }
  const common = [
    { label: 'Rename…', icon: 'pencil', onClick: () => renameItem(e) },
    { label: 'Move to…', icon: 'move', onClick: () => pickDestination(e) },
    { label: 'Protect', icon: 'lock', onClick: () => setProtected(e, true) },
    'sep',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteItem(e) },
  ];
  if (e.dir) {
    menu(anchor, [
      { label: 'New file…', icon: 'plus', onClick: () => createItem(e.path, false) },
      { label: 'New folder…', icon: 'folder', onClick: () => createItem(e.path, true) },
      'sep', ...common,
    ]);
  } else {
    menu(anchor, [
      { label: 'Open', icon: 'file', onClick: () => openFile(e.path) },
      { label: 'Add to chat', icon: 'paperclip', onClick: () => attachPath(e.path) },
      'sep', ...common,
    ]);
  }
}

// ------------------------------------------------------------------ guarded operations

async function createItem(parent, folder) {
  const name = await promptDialog({
    title: folder ? 'New folder' : 'New file',
    label: 'Name' + (parent ? ' — inside ' + parent : ''),
    placeholder: folder ? 'folder-name' : 'notes.md', confirmLabel: 'Create',
  });
  if (!name) return;
  try {
    const r = await api('/api/fs/create', { body: { project: pid(), parent, name, folder } });
    if (parent) tree().expanded.add(parent);
    await refreshTree();
    if (!folder) openFile(r.path);
  } catch (e) { fail(e); }
}

async function renameItem(e) {
  const name = await promptDialog({ title: 'Rename', label: 'New name', value: e.name, confirmLabel: 'Rename', selectStem: !e.dir });
  if (!name || name === e.name) return;
  try {
    const r = await api('/api/fs/move', { body: { project: pid(), from: e.path, name } });
    pathChanged(e.path, r.path);
    await refreshTree();
  } catch (err) { fail(err); }
}

async function moveItem(from, toParent) {
  try {
    const r = await api('/api/fs/move', { body: { project: pid(), from, toParent } });
    pathChanged(from, r.path);
    if (toParent) tree().expanded.add(toParent);
    await refreshTree();
    toast('Moved to ' + (toParent || 'the project root') + '.');
  } catch (e) { fail(e); }
}

async function deleteItem(e) {
  const ok = await confirmDialog({
    title: 'Delete ' + e.name + '?',
    message: h('div', { class: 'muted' }, (e.dir ? 'This folder and everything in it' : 'This file') + ' will be moved to the Windows Recycle Bin, so you can restore it from there.',
      h('div', { class: 'mono', style: { marginTop: '10px' } }, e.path)),
    confirmLabel: 'Move to Recycle Bin', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/fs/delete', { body: { project: pid(), path: e.path } });
    closeUnder(e.path);
    tree().expanded.delete(e.path);
    await refreshTree();
    toast(e.name + ' was moved to the Recycle Bin.');
  } catch (err) { fail(err); }
}

async function setProtected(e, onFlag) {
  try {
    await api('/api/fs/protect', { body: { project: pid(), path: e.path, on: onFlag } });
    if (onFlag) closeUnder(e.path);
    await refreshTree();
    toast(onFlag ? e.name + ' is now protected. Hearth will not open, change, move or delete it.' : 'Protection removed from ' + e.name + '.');
  } catch (err) { fail(err); }
}

function pickDestination(e) {
  let selected = null;
  const box = h('div', { class: 'folder-pick' });
  const moveBtn = h('button', { class: 'btn primary', disabled: true, onClick: () => { m.close(); moveItem(e.path, selected); } }, 'Move here');
  const expanded = new Set();

  const draw = async () => {
    const frag = document.createDocumentFragment();
    const rowFor = (label, path, depth, hasChev, open) => h('div', {
      class: 'tree-row dir' + (selected === path ? ' on' : '') + (open ? ' open' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' },
      onClick: () => {
        selected = path;
        if (hasChev) expanded.has(path) ? expanded.delete(path) : expanded.add(path);
        moveBtn.disabled = path === dirName(e.path);
        draw();
      },
    }, hasChev ? icon('chevron', 'chev') : h('span', { style: { width: '14px', flex: 'none' } }), icon('folder', 'ficon'), h('span', { class: 'tname' }, label));
    frag.append(rowFor(S.project.name + ' (project root)', '', 0, false, false));
    const walk = async (path, depth) => {
      const entries = await loadDir(path);
      for (const d of entries) {
        if (!d.dir || d.locked || d.path === e.path) continue;
        const open = expanded.has(d.path);
        frag.append(rowFor(d.name, d.path, depth, true, open));
        if (open) await walk(d.path, depth + 1);
      }
    };
    try { await walk('', 1); } catch (err) { frag.append(h('div', { class: 'empty-note' }, err.message)); }
    clear(box).append(frag);
  };

  const m = modal({
    title: 'Move ' + e.name,
    body: h('div', { class: 'modal-body' }, h('div', { class: 'hint' }, 'Choose a folder inside this project. Nothing will be overwritten.'), box),
    foot: [h('button', { class: 'btn ghost', onClick: () => m.close() }, 'Cancel'), moveBtn],
  });
  draw();
}

// ------------------------------------------------------------------ viewer / editor pane

function pathChanged(oldPath, newPath) {
  const st = pane();
  for (const t of st.tabs) {
    if (t.path === oldPath || t.path.startsWith(oldPath + '/')) {
      const wasActive = st.active === t.path;
      t.path = newPath + t.path.slice(oldPath.length);
      t.name = baseName(t.path);
      if (wasActive) st.active = t.path;
    }
  }
  const tr = tree();
  for (const p of [...tr.expanded]) {
    if (p === oldPath || p.startsWith(oldPath + '/')) { tr.expanded.delete(p); tr.expanded.add(newPath + p.slice(oldPath.length)); }
  }
  renderPane();
}

function closeUnder(path) {
  const st = pane();
  st.tabs = st.tabs.filter((t) => !(t.path === path || t.path.startsWith(path + '/')));
  if (!st.tabs.some((t) => t.path === st.active)) st.active = st.tabs.length ? st.tabs[st.tabs.length - 1].path : null;
  renderPane();
}

/** Called after something other than the tree (the model's approved file actions) changed files on disk. */
export function notifyMoved(oldPath, newPath) { pathChanged(oldPath, newPath); }
export function notifyDeleted(path) { tree().expanded.delete(path); closeUnder(path); }
export async function notifyChanged(path) {
  const tab = pane().tabs.find((t) => t.path === path);
  if (!tab || tab.editing) return;
  await loadTab(tab);
  renderPane();
}

async function loadTab(tab) {
  tab.loading = true; tab.error = '';
  try {
    const r = await api('/api/fs/read', { query: { project: pid(), path: tab.path } });
    Object.assign(tab, { binary: !!r.binary, content: r.content || '', eol: r.eol, bom: r.bom, modified: r.modified, size: r.size, readonly: !!r.readonly, truncated: !!r.truncated, editing: false, draft: null });
  } catch (e) { tab.error = e.message; }
  tab.loading = false;
}

export async function openFile(path) {
  const st = pane();
  let tab = st.tabs.find((t) => t.path === path);
  st.open = true;
  if (!tab) {
    tab = { path, name: baseName(path), loading: true };
    st.tabs.push(tab);
    st.active = path;
    renderPane();
    await loadTab(tab);
  }
  st.active = tab.path;
  renderPane();
  markActiveInTree();
}

function markActiveInTree() {
  if (!treeHost || S.sidebarTab !== 'files') return;
  const list = treeHost.querySelector('.tree-list');
  if (list && !tree().find.trim()) drawTree(list);
}

async function closeTab(tab) {
  if (tab.editing && tab.draft != null && tab.draft !== tab.content) {
    const ok = await confirmDialog({ title: 'Discard changes?', message: 'Your unsaved edits to ' + tab.name + ' will be lost.', confirmLabel: 'Discard', danger: true });
    if (!ok) return;
  }
  const st = pane();
  const i = st.tabs.indexOf(tab);
  st.tabs.splice(i, 1);
  if (st.active === tab.path) st.active = st.tabs.length ? st.tabs[Math.max(0, i - 1)].path : null;
  renderPane();
  markActiveInTree();
}

export function paneState() { return S.project ? pane() : { tabs: [], open: false }; }
export function togglePane() { const st = pane(); st.open = !st.open; renderPane(); }

export function renderPane() {
  const el = $('#filepane'), split = $('#splitter');
  const st = paneState();
  const show = st.open && st.tabs.length > 0;
  el.hidden = !show; split.hidden = !show;
  emit('pane');
  if (!show) return;
  clear(el);
  const tab = st.tabs.find((t) => t.path === st.active) || st.tabs[0];
  st.active = tab.path;

  const strip = h('div', { class: 'fp-tabstrip' });
  for (const t of st.tabs) {
    const dirty = t.editing && t.draft != null && t.draft !== t.content;
    strip.append(h('div', { class: 'fp-tab' + (t === tab ? ' on' : ''), title: t.path, onClick: () => { st.active = t.path; renderPane(); markActiveInTree(); },
      onAuxclick: (e) => { if (e.button === 1) closeTab(t); } },
      icon('file', 'sm'), h('span', null, t.name),
      dirty ? h('i', { class: 'dirty', title: 'Unsaved changes' }) : null,
      h('button', { class: 'x', title: 'Close', onClick: (e) => { e.stopPropagation(); closeTab(t); } }, icon('x', 'sm'))));
  }
  el.append(h('div', { class: 'fp-tabs' }, strip, h('button', { class: 'iconbtn', title: 'Hide file panel', onClick: togglePane }, icon('panel'))));

  const toolbar = h('div', { class: 'fp-toolbar' });
  const body = h('div', { class: 'fp-body' });
  el.append(toolbar, body);
  toolbar.append(h('div', { class: 'fp-path', title: tab.path }, h('bdi', null, tab.path)));

  if (tab.loading) { body.append(h('div', { class: 'fp-empty' }, h('div', { class: 'spinner' }))); return; }
  if (tab.error) { body.append(h('div', { class: 'fp-empty' }, h('div', null, icon('lock', 'lg'), h('div', { style: { marginTop: '10px' } }, tab.error)))); return; }
  if (tab.binary) { body.append(h('div', { class: 'fp-empty' }, 'This is a binary file (' + fmtBytes(tab.size) + '), so it cannot be shown as text.')); return; }

  if (tab.truncated) toolbar.append(h('span', { class: 'badge warn', title: 'Only the first 2 MB is shown' }, 'Truncated'));
  else if (tab.readonly) toolbar.append(h('span', { class: 'badge' }, 'Read-only'));

  if (tab.editing) {
    const ta = h('textarea', { class: 'code-edit', spellcheck: false, wrap: 'off' });
    ta.value = tab.draft != null ? tab.draft : tab.content;
    const save = async () => {
      try {
        const r = await api('/api/fs/write', { body: { project: pid(), path: tab.path, content: ta.value, eol: tab.eol, bom: tab.bom, modified: tab.modified } });
        tab.content = ta.value; tab.modified = r.modified; tab.size = r.size; tab.editing = false; tab.draft = null;
        toast('Saved ' + tab.name + '.');
        renderPane();
      } catch (e) { fail(e); }
    };
    ta.addEventListener('input', () => {
      const was = tab.draft != null && tab.draft !== tab.content;
      tab.draft = ta.value;
      const now = tab.draft !== tab.content;
      if (was !== now) {
        const cur = strip.querySelector('.fp-tab.on');
        const dot = cur.querySelector('.dirty');
        if (now && !dot) cur.insertBefore(h('i', { class: 'dirty', title: 'Unsaved changes' }), cur.querySelector('.x'));
        if (!now && dot) dot.remove();
      }
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const unit = /^\t/m.test(tab.content) ? '\t' : '    ';
        ta.setRangeText(unit, ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    toolbar.append(
      h('button', { class: 'btn sm ghost', onClick: () => { tab.editing = false; tab.draft = null; renderPane(); } }, 'Cancel'),
      h('button', { class: 'btn sm primary', title: 'Save (Ctrl+S)', onClick: save }, icon('save', 'sm'), 'Save'));
    body.append(ta);
    setTimeout(() => ta.focus(), 20);
    return;
  }

  toolbar.append(
    h('button', { class: 'btn sm ghost', title: 'Reload from disk', onClick: async () => { await loadTab(tab); renderPane(); } }, icon('refresh', 'sm')),
    tab.readonly ? null : h('button', { class: 'btn sm ghost', onClick: () => { tab.editing = true; tab.draft = tab.content; renderPane(); } }, icon('pencil', 'sm'), 'Edit'),
    h('button', { class: 'btn sm', title: 'Give this file to the model as context', onClick: () => emit('attach-file', { path: tab.path, content: tab.content }) }, icon('paperclip', 'sm'), 'Add to chat'));

  const lines = tab.content.split('\n').length;
  const nums = new Array(lines);
  for (let i = 0; i < lines; i++) nums[i] = i + 1;
  const code = h('code');
  code.innerHTML = highlight(tab.content, langForFile(tab.name));   // highlight() escapes all text
  body.append(h('div', { class: 'code-view' }, h('div', { class: 'gutter' }, nums.join('\n')), h('pre', null, code)));
}

export async function attachPath(path) {
  const open = pane().tabs.find((t) => t.path === path && !t.loading && !t.error);
  if (open && !open.binary) { emit('attach-file', { path, content: open.content }); return; }
  try {
    const r = await api('/api/fs/read', { query: { project: pid(), path } });
    if (r.binary) { toast(baseName(path) + ' is a binary file, so it cannot be added as text.', 'warn'); return; }
    emit('attach-file', { path, content: r.content || '' });
  } catch (e) { fail(e); }
}

export async function findFiles(q) {
  const r = await api('/api/fs/find', { query: { project: pid(), q } });
  return r.results;
}

// ------------------------------------------------------------------ splitter

(function wireSplitter() {
  const split = $('#splitter');
  try { const w = localStorage.getItem('hearth.filepane'); if (w) document.documentElement.style.setProperty('--filepane-w', w); } catch {}
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    split.classList.add('dragging');
    const move = (ev) => {
      const w = Math.max(340, Math.min(window.innerWidth * 0.7, window.innerWidth - ev.clientX));
      document.documentElement.style.setProperty('--filepane-w', w + 'px');
    };
    const up = () => {
      split.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('hearth.filepane', getComputedStyle(document.documentElement).getPropertyValue('--filepane-w')); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

on('project', () => { renderPane(); });
