// Boot, sidebar, project switching and window lifetime.

import { h, icon, api, S, emit, on, $, clear, toast, fail, modal, popover, closePop, confirmDialog } from './util.js';
import { refreshModels, openHub, openLocalPanel, activeDownloads } from './models.js';
import { renderFilesTab, refreshTree } from './files.js';
import { initMain, renderChatsTab, newChat } from './chat.js';

let sb = null;

// ------------------------------------------------------------------ sidebar

function buildSidebar() {
  const host = $('#sidebar');
  clear(host);
  const themeBtn = h('button', { class: 'iconbtn', title: 'Switch light / dark', onClick: toggleTheme });
  const projectBtn = h('button', { class: 'project-switch', title: 'Switch project', onClick: () => openProjectMenu(projectBtn) });
  const tabs = h('div', { class: 'sb-tabs' });
  const body = h('div', { class: 'sb-body' });
  const modelsBtn = h('button', { class: 'foot-btn', onClick: () => openHub(activeDownloads() ? 'discover' : 'installed') });
  const pill = h('button', { class: 'local-pill', onClick: openLocalPanel });

  host.append(
    h('div', { class: 'sb-head' }, h('img', { class: 'sb-logo', src: '/icon.svg', alt: '' }), h('span', { class: 'sb-name' }, 'Hearth'), themeBtn),
    projectBtn,
    h('div', { class: 'sb-new' }, h('button', { class: 'btn block', onClick: () => { S.sidebarTab = 'chats'; drawTabs(); newChat(); } }, icon('plus'), 'New chat')),
    tabs, body,
    h('div', { class: 'sb-foot' }, modelsBtn, pill));
  sb = { themeBtn, projectBtn, tabs, body, modelsBtn, pill };
  drawTheme(); drawProject(); drawTabs(); drawFoot();
}

function drawTheme() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  clear(sb.themeBtn).append(icon(dark ? 'sun' : 'moon'));
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('hearth.theme', next); } catch {}
  drawTheme();
}

function drawProject() {
  const p = S.project;
  clear(sb.projectBtn).append(
    h('span', { class: 'pi' }, icon('folder')),
    h('span', { class: 'grow' },
      h('div', { class: 'pn truncate' }, p.name),
      h('div', { class: 'pp truncate' }, p.path ? (p.missing ? 'Folder missing — ' : '') + p.path : 'No folder linked')),
    icon('down', 'sm'));
}

function drawTabs() {
  clear(sb.tabs);
  for (const [id, label, ic] of [['chats', 'Chats', 'chat'], ['files', 'Files', 'file']])
    sb.tabs.append(h('button', { class: 'sb-tab' + (S.sidebarTab === id ? ' on' : ''), onClick: () => { S.sidebarTab = id; drawTabs(); } }, icon(ic, 'sm'), label));
  drawBody();
}

function drawBody() {
  if (S.sidebarTab === 'chats') renderChatsTab(sb.body);
  else renderFilesTab(sb.body);
}

function drawFoot() {
  const n = activeDownloads();
  clear(sb.modelsBtn).append(icon('cube'), 'Models',
    n ? h('span', { class: 'badge accent' }, icon('download', 'sm'), n + ' downloading') : h('span', { class: 'badge' }, S.models.length + ' installed'));
  const up = S.ollama.running;
  sb.pill.classList.toggle('down', !up);
  clear(sb.pill).append(icon(up ? 'shield' : 'alert', 'lg'),
    h('span', null, up ? 'Local only' : 'Ollama is not running',
      h('small', null, up ? 'AI runs on this PC' + (S.blocked.length ? ' · ' + S.blocked.length + ' cloud model' + (S.blocked.length > 1 ? 's' : '') + ' blocked' : '') : 'Nothing can run until it starts')));
}

// ------------------------------------------------------------------ projects

async function reloadProjects(selectId) {
  const st = await api('/api/state');
  S.projects = st.projects;
  S.project = S.projects.find((p) => p.id === (selectId || (S.project && S.project.id))) || S.projects[0];
}

async function switchProject(p) {
  if (S.project && S.project.id === p.id) return;
  S.project = p;
  drawProject();
  drawBody();
  emit('project');
  try { S.settings = await api('/api/settings', { body: { activeProject: p.id } }); } catch (e) { fail(e); }
}

function openProjectMenu(anchor) {
  const list = h('div', { class: 'pop-list' });
  for (const p of S.projects) {
    list.append(h('button', { class: 'opt', onClick: () => { closePop(); switchProject(p); } },
      h('span', { class: 'pi', style: { color: 'var(--accent)' } }, icon('folder')),
      h('div', { class: 'o-main' }, h('div', { class: 'o-title' }, p.name), h('div', { class: 'o-sub' }, p.path || 'No folder linked')),
      p.id === S.project.id ? icon('check', 'check') : null));
  }
  const pop = popover(anchor, [
    list,
    h('div', { class: 'pop-foot' },
      h('button', { class: 'menu-item', onClick: () => { closePop(); projectDialog(null); } }, icon('plus'), 'New project…'),
      h('button', { class: 'menu-item', onClick: () => { closePop(); projectDialog(S.project); } }, icon('sliders'), 'Project settings…')),
  ]);
  pop.el.style.width = '320px';
}

function projectDialog(project) {
  const editing = !!project;
  const name = h('input', { class: 'input', placeholder: 'My project', value: editing ? project.name : '', spellcheck: false });
  const path = h('input', { class: 'input mono', placeholder: 'D:\\Code\\my-project', value: editing ? project.path || '' : '', spellcheck: false });
  const browse = h('button', { class: 'btn', onClick: async () => {
    browse.disabled = true;
    try {
      const r = await api('/api/pick-folder', { body: {} });
      if (r.path) {
        path.value = r.path;
        if (!name.value.trim()) name.value = r.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      }
    } catch (e) { fail(e); }
    browse.disabled = false;
  } }, icon('folder'), 'Browse…');

  const save = async () => {
    try {
      let saved;
      if (editing) saved = await api('/api/projects/update', { body: { id: project.id, name: name.value.trim() || project.name, path: path.value.trim() } });
      else saved = await api('/api/projects/add', { body: { name: name.value.trim(), path: path.value.trim() } });
      m.close();
      const wasCurrent = editing && S.project.id === project.id;
      await reloadProjects(saved.id);
      drawProject();
      if (wasCurrent) { drawBody(); emit('project'); }
      else { const target = S.project; S.project = null; await switchProject(target); }
      toast(editing ? 'Project updated.' : 'Project "' + saved.name + '" created.');
    } catch (e) { fail(e); }
  };

  const remove = editing && S.projects.length > 1 ? h('button', { class: 'btn danger left', onClick: async () => {
    const ok = await confirmDialog({
      title: 'Remove "' + project.name + '"?',
      message: 'This removes the project and its chat history from Hearth. The files in its folder are not touched.',
      confirmLabel: 'Remove project', danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/projects/remove', { body: { id: project.id } });
      m.close();
      const wasCurrent = S.project.id === project.id;
      await reloadProjects();
      drawProject();
      if (wasCurrent) { const target = S.project; S.project = null; await switchProject(target); }
      toast('Project removed.');
    } catch (e) { fail(e); }
  } }, 'Remove project') : null;

  for (const el of [name, path]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const m = modal({
    title: editing ? 'Project settings' : 'New project',
    body: h('div', { class: 'modal-body' },
      h('div', { class: 'field' }, h('label', null, 'Name'), name),
      h('div', { class: 'field' }, h('label', null, 'Folder'), h('div', { class: 'row' }, h('div', { class: 'grow' }, path), browse),
        h('div', { class: 'hint' }, 'Optional. Hearth can only see and change files inside this folder — never system folders, whole drives, or credential files.'))),
    foot: [remove, h('button', { class: 'btn ghost', onClick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onClick: save }, editing ? 'Save' : 'Create project')],
  });
}

// ------------------------------------------------------------------ lifetime

async function lifeline() {
  // An open connection tells the local service this window is alive; it shuts down when the last window closes.
  let fails = 0;
  for (;;) {
    try {
      const res = await fetch('/api/lifeline');
      if (!res.ok) throw new Error('lifeline');
      fails = 0;
      const reader = res.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch {}
    if (++fails >= 4) break;
    await new Promise((r) => setTimeout(r, 900));
  }
  document.body.append(h('div', { class: 'dead' }, h('div', null,
    h('img', { src: '/icon.svg', width: 48, height: 48, alt: '' }),
    h('h2', null, 'Hearth has stopped'),
    h('p', null, 'Close this window and open Hearth again.'))));
}

// ------------------------------------------------------------------ boot

on('chats', () => { if (sb && S.sidebarTab === 'chats') renderChatsTab(sb.body); });
on('models', () => { if (sb) drawFoot(); });
on('downloads', () => { if (sb) drawFoot(); });
on('edit-project', (id) => projectDialog(S.projects.find((p) => p.id === id) || S.project));

async function boot() {
  try {
    const st = await api('/api/state');
    S.ollama = st.ollama; S.hardware = st.hardware; S.settings = st.settings || {}; S.projects = st.projects; S.sourceLevel = st.sourceLevel || 'trusted';
    S.project = S.projects.find((p) => p.id === S.settings.activeProject) || S.projects[0];
  } catch (e) {
    document.body.append(h('div', { class: 'dead' }, h('div', null, h('h2', null, 'Hearth could not start'), h('p', null, e.message))));
    return;
  }
  initMain();
  buildSidebar();
  await refreshModels();
  emit('project');
  lifeline();
  setInterval(() => { if (!document.hidden) refreshModels(); }, 20000);
  window.addEventListener('focus', () => { refreshModels(); if (S.sidebarTab === 'files') refreshTree(); });
}

boot();
