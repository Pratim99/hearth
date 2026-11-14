// File tools the local model may ask for.
//
// The model never touches files itself. It can only *request* one of the actions below; listing and
// reading run straight away, while anything that changes the project is shown to the user and runs
// only after they press Allow. Every action then goes through the same guarded backend endpoints as
// the Files tab, so locked items, the project boundary, no-overwrite and Recycle Bin rules all apply.

import { h, icon, api, S, fmtBytes, baseName, dirName } from './util.js';
import { refreshTree, notifyMoved, notifyDeleted, notifyChanged } from './files.js';

const MAX_READ_CHARS = 60000;
const pid = () => S.project.id;

export function normPath(p) {
  const s = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}
const show = (p) => normPath(p) || 'the project root';

const str = (description) => ({ type: 'string', description });
const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const TOOL_SCHEMAS = [
  fn('list_files', 'List the files and folders directly inside a folder of the project.', { path: str('Folder path relative to the project root. Use an empty string for the root.') }, ['path']),
  fn('read_file', 'Read the text of a file in the project.', { path: str('File path relative to the project root.') }, ['path']),
  fn('create_file', 'Create a new file with the given text. Fails if the file already exists or its folder does not exist. The user must approve.', { path: str('New file path relative to the project root.'), content: str('The full text to put in the file.') }, ['path', 'content']),
  fn('edit_file', 'Change part of an existing text file by replacing one exact piece of its text. Read the file first and copy old_text exactly, including spaces and line breaks; it must appear in the file exactly once. The user sees the before and after and must approve.', { path: str('File path relative to the project root.'), old_text: str('The exact text to replace. Include enough surrounding lines to make it unique.'), new_text: str('The text to put in its place. Use an empty string to remove old_text.') }, ['path', 'old_text', 'new_text']),
  fn('replace_file', 'Rewrite an existing text file completely with new content. Prefer edit_file for small changes. The user sees the before and after and must approve.', { path: str('File path relative to the project root.'), content: str('The complete new text of the file.') }, ['path', 'content']),
  fn('create_folder', 'Create a new, empty folder. The user must approve.', { path: str('New folder path relative to the project root.') }, ['path']),
  fn('move_path', 'Move or rename a file or folder inside the project. Never overwrites. The user must approve.', { from: str('Current path relative to the project root.'), to: str('New path relative to the project root, including the file or folder name.') }, ['from', 'to']),
  fn('delete_path', 'Delete a file or folder by sending it to the Recycle Bin. The user must approve.', { path: str('Path relative to the project root.') }, ['path']),
];

export const TOOL_PROMPT =
  'You can work with the files in the user\'s project folder using the provided tools. Paths are relative to the project root and use forward slashes. ' +
  'Look before you act: list or read first when you are unsure what exists. Creating, editing, moving and deleting are shown to the user, who approves or declines each one; ' +
  'if an action is declined or refused, do not retry it — explain and carry on. Some files and folders are locked for safety and cannot be accessed. ' +
  'To change an existing file, read it first, then use edit_file to replace an exact piece of its text, or replace_file to rewrite the whole file.';

// ------------------------------------------------------------------ before / after preview

/** Line-by-line comparison of two texts: [{ op: ' ' | '-' | '+', text }]. */
export function diffLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const out = a.slice(0, start).map((text) => ({ op: ' ', text }));

  if (midA.length * midB.length > 4000000) {
    for (const text of midA) out.push({ op: '-', text });
    for (const text of midB) out.push({ op: '+', text });
  } else {
    const n = midA.length, m = midB.length, w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ op: ' ', text: midA[i] }); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ op: '-', text: midA[i++] });
      else out.push({ op: '+', text: midB[j++] });
    }
    while (i < n) out.push({ op: '-', text: midA[i++] });
    while (j < m) out.push({ op: '+', text: midB[j++] });
  }
  for (const text of a.slice(endA)) out.push({ op: ' ', text });
  return out;
}

/** Renders a comparison, folding long unchanged stretches so the changes stay in view. */
function diffView(before, after) {
  const rows = diffLines(before, after);
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => { if (r.op !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep[k] = 1; });
  const pre = h('pre', { class: 'tc-diff' });
  let added = 0, removed = 0, skipped = 0, shown = 0;
  const flush = () => { if (skipped) { pre.append(h('div', { class: 'd-skip' }, '⋯ ' + skipped + ' unchanged line' + (skipped === 1 ? '' : 's'))); skipped = 0; } };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.op === '+') added++; else if (r.op === '-') removed++;
    if (!keep[i]) { skipped++; continue; }
    if (shown >= 400) continue;
    flush();
    pre.append(h('div', { class: r.op === '+' ? 'd-add' : r.op === '-' ? 'd-del' : 'd-ctx' }, r.op + ' ' + r.text));
    shown++;
  }
  flush();
  if (shown >= 400) pre.append(h('div', { class: 'd-skip' }, '⋯ more changes not shown'));
  const summary = h('div', { class: 'tc-line faint' },
    !added && !removed ? 'No lines would change.' : [added ? added + ' line' + (added === 1 ? '' : 's') + ' added' : '', removed ? removed + ' removed' : ''].filter(Boolean).join(', ') + '.');
  return [summary, pre];
}

async function readForEdit(path) {
  const p = normPath(path);
  if (!p) throw new Error('A file path is required.');
  const r = await api('/api/fs/read', { query: { project: pid(), path: p } });
  if (r.binary) throw new Error('This is a binary file, so it cannot be edited as text.');
  if (r.truncated) throw new Error('This file is too large to edit here.');
  if (r.readonly) throw new Error('This file is read-only.');
  return { path: r.path, before: r.content || '', eol: r.eol, bom: r.bom, modified: r.modified };
}

/** Saves a prepared edit. The stamp makes the save fail if the file changed after the preview was shown. */
async function saveEdit(prep) {
  await api('/api/fs/write', { body: { project: pid(), path: prep.path, content: prep.after, eol: prep.eol, bom: prep.bom, modified: prep.modified } });
  await notifyChanged(prep.path);
  return 'Saved the change to ' + prep.path + '.';
}

function editDetail(a, t, fallbackBefore, fallbackAfter) {
  if (t && t.prep) return diffView(t.prep.before, t.prep.after);
  return diffView(String(fallbackBefore == null ? '' : fallbackBefore), String(fallbackAfter == null ? '' : fallbackAfter));   // reloaded chat: show what was asked
}

export const TOOLS = {
  edit_file: {
    write: true, icon: 'pencil', title: (a) => 'Edit ' + show(a.path),
    detail: (a, t) => editDetail(a, t, a.old_text, a.new_text),
    async prepare(a) {
      const prep = await readForEdit(a.path);
      const oldText = String(a.old_text == null ? '' : a.old_text).replace(/\r\n/g, '\n');
      const newText = String(a.new_text == null ? '' : a.new_text).replace(/\r\n/g, '\n');
      if (!oldText) throw new Error('old_text is empty. Give the exact text to replace, or use replace_file to rewrite the whole file.');
      const first = prep.before.indexOf(oldText);
      if (first < 0) throw new Error('old_text was not found in ' + prep.path + '. Read the file again and copy the text exactly, including spaces and line breaks.');
      if (prep.before.indexOf(oldText, first + 1) >= 0) throw new Error('old_text appears more than once in ' + prep.path + '. Include more of the surrounding lines so it matches one place only.');
      if (oldText === newText) throw new Error('old_text and new_text are identical, so nothing would change.');
      prep.after = prep.before.slice(0, first) + newText + prep.before.slice(first + oldText.length);
      return prep;
    },
    run: (a, prep) => saveEdit(prep),
  },
  replace_file: {
    write: true, icon: 'pencil', title: (a) => 'Rewrite ' + show(a.path),
    detail: (a, t) => (t && t.prep ? diffView(t.prep.before, t.prep.after) : h('pre', { class: 'tc-preview' }, String(a.content == null ? '' : a.content).slice(0, 6000))),
    async prepare(a) {
      const prep = await readForEdit(a.path);
      prep.after = String(a.content == null ? '' : a.content).replace(/\r\n/g, '\n');
      if (prep.after === prep.before) throw new Error('The new content is identical to the file, so nothing would change.');
      return prep;
    },
    run: (a, prep) => saveEdit(prep),
  },
  list_files: {
    label: (a) => 'Listed ' + show(a.path), busy: (a) => 'Listing ' + show(a.path),
    async run(a) {
      const r = await api('/api/fs/list', { query: { project: pid(), path: normPath(a.path) } });
      if (!r.entries.length) return 'This folder is empty.';
      const lines = r.entries.slice(0, 400).map((e) => (e.locked ? '[locked] ' : '') + (e.dir ? e.path + '/' : e.path + ' (' + (fmtBytes(e.size) || '0 B') + ')'));
      if (r.entries.length > 400) lines.push('… and ' + (r.entries.length - 400) + ' more');
      return lines.join('\n');
    },
  },
  read_file: {
    label: (a) => 'Read ' + show(a.path), busy: (a) => 'Reading ' + show(a.path),
    async run(a) {
      const r = await api('/api/fs/read', { query: { project: pid(), path: normPath(a.path) } });
      if (r.binary) return 'This is a binary file and cannot be read as text.';
      const text = r.content || '';
      return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + '\n… (file truncated)' : text || '(the file is empty)';
    },
  },
  create_file: {
    write: true, icon: 'file', title: (a) => 'Create file ' + show(a.path),
    detail: (a) => h('pre', { class: 'tc-preview' }, String(a.content == null ? '' : a.content).slice(0, 6000) || '(empty file)'),
    async run(a) {
      const p = normPath(a.path);
      if (!p) throw new Error('A file path is required.');
      const r = await api('/api/fs/create', { body: { project: pid(), parent: dirName(p), name: baseName(p), folder: false, content: String(a.content == null ? '' : a.content) } });
      await refreshTree();
      return 'Created ' + r.path + '.';
    },
  },
  create_folder: {
    write: true, icon: 'folder', title: (a) => 'Create folder ' + show(a.path),
    async run(a) {
      const p = normPath(a.path);
      if (!p) throw new Error('A folder path is required.');
      const r = await api('/api/fs/create', { body: { project: pid(), parent: dirName(p), name: baseName(p), folder: true } });
      await refreshTree();
      return 'Created folder ' + r.path + '.';
    },
  },
  move_path: {
    write: true, icon: 'move', title: (a) => 'Move ' + show(a.from),
    detail: (a) => h('div', { class: 'tc-line' }, h('span', { class: 'mono' }, show(a.from)), icon('move', 'sm'), h('span', { class: 'mono' }, show(a.to))),
    async run(a) {
      const from = normPath(a.from), to = normPath(a.to);
      if (!from || !to) throw new Error('Both a current path and a new path are required.');
      const r = await api('/api/fs/move', { body: { project: pid(), from, toParent: dirName(to), name: baseName(to) } });
      notifyMoved(from, r.path);
      await refreshTree();
      return 'Moved ' + from + ' to ' + r.path + '.';
    },
  },
  delete_path: {
    write: true, icon: 'trash', danger: true, title: (a) => 'Delete ' + show(a.path),
    detail: () => h('div', { class: 'tc-line faint' }, 'It goes to the Windows Recycle Bin, so you can restore it.'),
    async run(a) {
      const p = normPath(a.path);
      if (!p) throw new Error('A path is required.');
      await api('/api/fs/delete', { body: { project: pid(), path: p } });
      notifyDeleted(p);
      await refreshTree();
      return 'Moved ' + p + ' to the Recycle Bin.';
    },
  },
};

const STATUS = {
  pending: ['warn', 'Needs your approval'], running: ['accent', 'Working…'], done: ['ok', 'Done'],
  denied: ['', 'Declined'], error: ['danger', 'Not done'], cancelled: ['', 'Not run'],
};

/** One row per requested action. `decide(tool, allowed)` is called by the Allow / Deny buttons. */
export function toolRows(tools, decide) {
  return tools.map((t) => {
    const spec = TOOLS[t.name];
    const a = t.args || {};
    if (!spec) return h('div', { class: 'toolcall read error' }, icon('alert', 'sm'), 'The model asked for an action Hearth does not offer (' + t.name + ').');
    if (!spec.write) {
      const failed = t.status === 'error';
      return h('div', { class: 'toolcall read ' + t.status, title: failed ? t.result : '' },
        t.status === 'running' ? h('span', { class: 'spinner' }) : icon(failed ? 'alert' : t.status === 'cancelled' ? 'x' : 'check', 'sm'),
        h('span', null, t.status === 'running' ? spec.busy(a) : failed ? 'Could not ' + spec.busy(a).toLowerCase().replace(/^listing/, 'list').replace(/^reading/, 'read') : spec.label(a)),
        failed ? h('span', { class: 'faint truncate' }, '— ' + String(t.result).replace(/^Error: /, '')) : null);
    }
    const [kind, text] = STATUS[t.status] || STATUS.cancelled;
    return h('div', { class: 'toolcall write ' + t.status },
      h('div', { class: 'tc-head' }, icon(spec.icon), h('b', { class: 'truncate' }, spec.title(a)), h('span', { class: 'badge ' + kind }, text)),
      spec.detail ? spec.detail(a, t) : null,
      t.status === 'error' ? h('div', { class: 'tc-error' }, String(t.result).replace(/^Error: /, '')) : null,
      t.status === 'pending' ? h('div', { class: 'tc-actions' },
        h('span', { class: 'faint grow' }, 'The model is asking to change your project.'),
        h('button', { class: 'btn sm ghost', onClick: () => decide(t, false) }, 'Deny'),
        h('button', { class: 'btn sm ' + (spec.danger ? 'danger' : 'primary'), onClick: () => decide(t, true) }, 'Allow')) : null);
  });
}
