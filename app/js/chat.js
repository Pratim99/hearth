// Chats: the conversation list, the message thread, the composer, and streaming replies from the local model.

import { h, icon, api, ndjson, S, emit, on, $, clear, toast, fail, menu, popover, closePop, confirmDialog, promptDialog, fmtTokens, fmtCount, uid, dayGroup, baseName, dirName, copyText } from './util.js';
import { renderMarkdown } from './md.js';
import { currentModel, modelInfo, hasCap, openModelPicker, openHub, refreshModels } from './models.js';
import { findFiles, attachPath, openFile, togglePane, paneState } from './files.js';
import { TOOLS, TOOL_SCHEMAS, TOOL_PROMPT, toolRows } from './tools.js';

const MAX_ATTACH_CHARS = 400000;
let attachments = [];
let streaming = null;       // { ctl, msg, els }
let ui = null;              // skeleton element refs

// ------------------------------------------------------------------ persistence

export async function loadChats() {
  try { S.chats = (await api('/api/chats', { query: { project: S.project.id } })).chats; }
  catch (e) { S.chats = []; fail(e); }
  emit('chats');
}

function clean(chat) {
  return {
    id: chat.id, title: chat.title, model: chat.model, created: chat.created, updated: chat.updated, ctxUsed: chat.ctxUsed || 0,
    messages: chat.messages.map((m) => ({
      role: m.role, content: m.content, thinking: m.thinking || undefined, files: m.files && m.files.length ? m.files : undefined,
      model: m.model, stats: m.stats, error: m.error, stopped: m.stopped,
      tools: m.tools && m.tools.length ? m.tools.map((t) => {
        const finished = t.status === 'done' || t.status === 'denied' || t.status === 'error';
        return { name: t.name, args: t.args, status: finished ? t.status : 'cancelled', result: finished ? t.result : 'This action was not run.' };
      }) : undefined,
    })),
  };
}

async function saveChat(chat = S.chat) {
  if (!chat || !chat.messages.length) return;
  chat.updated = Date.now();
  const data = clean(chat);
  try {
    if (!chat.projectId) chat.projectId = S.project.id;
    await api('/api/chats/save?project=' + encodeURIComponent(chat.projectId), { body: data });
    if (!S.project || chat.projectId !== S.project.id) return;
    const entry = { id: chat.id, title: chat.title, model: chat.model, updated: chat.updated, count: chat.messages.length };
    S.chats = [entry, ...S.chats.filter((c) => c.id !== chat.id)];
    emit('chats');
  } catch (e) { fail(e); }
}

function rememberChat(id) {
  try { id ? localStorage.setItem('hearth.chat.' + S.project.id, id) : localStorage.removeItem('hearth.chat.' + S.project.id); } catch {}
}

export async function openChat(id) {
  stop();
  try {
    const chat = await api('/api/chats/get', { query: { project: S.project.id, id } });
    chat.projectId = S.project.id;
    S.chat = chat;
    rememberChat(id);
  } catch (e) { S.chat = null; rememberChat(null); fail(e); }
  attachments = [];
  drawAll();
  emit('chats');
}

export function newChat() {
  stop();
  S.chat = null;
  attachments = [];
  rememberChat(null);
  drawAll();
  emit('chats');
  if (ui) ui.input.focus();
}

async function restoreChat() {
  let id = null;
  try { id = localStorage.getItem('hearth.chat.' + S.project.id); } catch {}
  if (id && S.chats.some((c) => c.id === id)) await openChat(id);
  else newChat();
}

async function deleteChat(c) {
  const ok = await confirmDialog({ title: 'Delete this chat?', message: '"' + c.title + '" will be removed from this project. This cannot be undone.', confirmLabel: 'Delete chat', danger: true });
  if (!ok) return;
  try {
    await api('/api/chats/delete', { body: { project: S.project.id, id: c.id } });
    S.chats = S.chats.filter((x) => x.id !== c.id);
    if (S.chat && S.chat.id === c.id) newChat(); else emit('chats');
  } catch (e) { fail(e); }
}

async function renameChat(c) {
  const title = await promptDialog({ title: 'Rename chat', value: c.title, confirmLabel: 'Rename' });
  if (!title) return;
  try {
    let chat = S.chat && S.chat.id === c.id ? S.chat : await api('/api/chats/get', { query: { project: S.project.id, id: c.id } });
    chat.title = title;
    await api('/api/chats/save?project=' + encodeURIComponent(S.project.id), { body: S.chat === chat ? clean(chat) : chat });
    c.title = title;
    emit('chats');
    if (S.chat === chat) drawTopbar();
  } catch (e) { fail(e); }
}

// ------------------------------------------------------------------ sidebar list

export function renderChatsTab(host) {
  clear(host);
  if (!S.chats.length) {
    host.append(h('div', { class: 'empty-note' }, 'No chats in this project yet. Ask something below to start one.'));
    return;
  }
  let group = '';
  for (const c of S.chats) {
    const g = dayGroup(c.updated || 0);
    if (g !== group) { group = g; host.append(h('div', { class: 'sb-section' }, g)); }
    const openMenu = (anchor) => menu(anchor, [
      { label: 'Rename…', icon: 'pencil', onClick: () => renameChat(c) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteChat(c) },
    ]);
    host.append(h('div', {
      class: 'item' + (S.chat && S.chat.id === c.id ? ' on' : ''), role: 'button', tabindex: '0', title: c.title,
      onClick: () => { if (!S.chat || S.chat.id !== c.id) openChat(c.id); },
      onKeydown: (e) => { if (e.key === 'Enter') openChat(c.id); },
      onContextmenu: (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); },
    },
      h('span', { class: 'label-text' }, c.title),
      h('button', { class: 'iconbtn item-more', title: 'More', onClick: (e) => { e.stopPropagation(); openMenu(e.currentTarget); } }, icon('more'))));
  }
}

// ------------------------------------------------------------------ main skeleton

export function initMain() {
  const main = $('#main');
  clear(main);
  const title = h('input', { class: 'chat-title', spellcheck: false, 'aria-label': 'Chat title' });
  title.addEventListener('change', () => {
    if (!S.chat) { title.value = 'New chat'; return; }
    S.chat.title = title.value.trim() || 'Untitled chat';
    title.value = S.chat.title;
    saveChat();
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });

  const modelBtn = h('button', { class: 'model-btn', title: 'Switch model', onClick: () => openModelPicker(modelBtn) });
  const optsBtn = h('button', { class: 'iconbtn', title: 'Chat settings', onClick: () => openSettings(optsBtn) }, icon('sliders'));
  const paneBtn = h('button', { class: 'iconbtn', title: 'Show or hide open files', onClick: () => togglePane() }, icon('panel'));
  const banner = h('div');
  const thread = h('div', { class: 'thread' });
  const messages = h('div', { class: 'messages' }, thread);
  const chips = h('div', { class: 'composer-chips', hidden: true });
  const input = h('textarea', { rows: 1, placeholder: 'Ask anything — it runs on this PC', spellcheck: true });
  const attachBtn = h('button', { class: 'toggle', title: 'Attach a project file as context', onClick: () => openAttach(attachBtn) }, icon('paperclip'), 'Attach');
  const thinkBtn = h('button', { class: 'toggle', title: 'Let the model reason before answering', onClick: toggleThink }, icon('bulb'), 'Think');
  const toolsBtn = h('button', { class: 'toggle', title: 'Let the model list and read this project\'s files and propose creating, moving or deleting them. You approve every change.', onClick: toggleTools }, icon('folder'), 'File tools');
  const meter = h('div', { class: 'ctx-meter' });
  const send = h('button', { class: 'send', title: 'Send (Enter)', onClick: () => (streaming ? stop() : sendMessage()) }, icon('send'));

  input.addEventListener('input', () => { autosize(); drawMeter(); drawSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!streaming) sendMessage(); }
  });
  messages.addEventListener('click', onThreadClick);

  main.append(
    h('div', { class: 'topbar' }, title, h('div', { class: 'grow' }), modelBtn, optsBtn, paneBtn),
    banner, messages,
    h('div', { class: 'composer-wrap' },
      h('div', { class: 'composer' }, chips, input, h('div', { class: 'composer-bar' }, attachBtn, thinkBtn, toolsBtn, meter, send)),
      h('div', { class: 'composer-note' }, 'Local models can be wrong — check anything important.')));

  ui = { title, modelBtn, optsBtn, paneBtn, banner, thread, messages, chips, input, attachBtn, thinkBtn, toolsBtn, meter, send };
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; };
  ui.autosize = autosize;
}

function drawAll() { drawTopbar(); drawBanner(); drawMessages(); drawComposer(); }

function drawTopbar() {
  if (!ui) return;
  ui.title.value = S.chat ? S.chat.title : 'New chat';
  ui.title.disabled = !S.chat;
  const model = currentModel();
  clear(ui.modelBtn);
  ui.modelBtn.classList.toggle('none', !model);
  ui.modelBtn.append(icon('cube'), h('span', { class: 'truncate' }, model || 'No model'), icon('down', 'sm'));
  ui.paneBtn.hidden = !paneState().tabs.length;
  ui.paneBtn.classList.toggle('on', paneState().open && paneState().tabs.length > 0);
}

function drawBanner() {
  if (!ui) return;
  clear(ui.banner);
  if (!S.ollama.running) {
    const btn = h('button', { class: 'btn sm', onClick: async () => {
      btn.disabled = true; btn.textContent = 'Starting…';
      try {
        const r = await api('/api/ollama/start', { body: {} });
        if (!r.started) { toast('Ollama does not seem to be installed on this PC.', 'error', 7000); btn.disabled = false; btn.textContent = 'Start Ollama'; return; }
        for (let i = 0; i < 12 && !S.ollama.running; i++) { await new Promise((r2) => setTimeout(r2, 900)); await refreshModels(); }
        if (!S.ollama.running) { btn.disabled = false; btn.textContent = 'Start Ollama'; toast('Ollama did not start in time.', 'error'); }
      } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Start Ollama'; }
    } }, 'Start Ollama');
    ui.banner.append(h('div', { class: 'banner danger' }, icon('alert'), h('div', { class: 'grow' }, h('b', null, 'Ollama is not running on this PC. '), 'Hearth needs it to run models locally.'), btn));
  } else if (!S.models.length) {
    ui.banner.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', { class: 'grow' }, h('b', null, 'No local models installed yet. '), 'Download one to start chatting.'),
      h('button', { class: 'btn sm primary', onClick: () => openHub('discover') }, icon('download', 'sm'), 'Browse models')));
  }
}

// ------------------------------------------------------------------ messages

function welcome() {
  const model = currentModel();
  const gpu = S.hardware.gpu;
  return h('div', { class: 'welcome' },
    h('img', { src: '/icon.svg', alt: '' }),
    h('h1', null, 'What are we working on?'),
    h('p', null, model ? 'Ready with ' + model + (gpu ? ' on your ' + gpu : '') + '. Nothing you type leaves this PC.' : 'Install a local model to get started. Nothing you type leaves this PC.'),
    h('div', { class: 'tips' },
      h('div', { class: 'tip' }, icon('paperclip'), h('div', null, h('b', null, 'Give it context. '), 'Open a file from the Files tab and choose Add to chat, or use Attach below.')),
      h('div', { class: 'tip' }, icon('cube'), h('div', null, h('b', null, 'Switch models any time. '), 'Use the picker at the top right, or find and download new ones under Models.')),
      h('div', { class: 'tip' }, icon('shield'), h('div', null, h('b', null, 'Local only. '), 'Cloud models are blocked, and file changes stay inside guardrails.'))));
}

function drawMessages() {
  if (!ui) return;
  clear(ui.thread);
  const chat = S.chat;
  const empty = !chat || !chat.messages.length;
  ui.messages.classList.toggle('is-empty', empty);
  ui.thread.hidden = empty;
  const old = ui.messages.querySelector('.welcome');
  if (old) old.remove();
  if (empty) { ui.messages.append(welcome()); return; }
  chat.messages.forEach((m, i) => ui.thread.append(messageEl(m, i === chat.messages.length - 1, i > 0 && m.role === 'assistant' && chat.messages[i - 1].role === 'assistant')));
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function fileChip(f) {
  return h('button', { class: 'chip static', title: f.path, onClick: () => { if (S.project.path) openFile(f.path); } }, icon('file', 'sm'), h('span', null, baseName(f.path)));
}

function messageEl(m, isLast, cont) {
  if (m.role === 'user') {
    return h('div', { class: 'msg user' },
      m.files && m.files.length ? h('div', { class: 'msg-files' }, m.files.map(fileChip)) : null,
      m.content ? h('div', { class: 'bubble' }, m.content) : null,
      h('div', { class: 'msg-foot' }, h('button', { class: 'iconbtn', title: 'Copy', onClick: (e) => copied(e.currentTarget, m.content) }, icon('copy', 'sm'))));
  }
  const el = h('div', { class: 'msg assistant' + (cont ? ' cont' : '') });
  const tools = h('div', { class: 'toolcalls', hidden: true });
  const think = h('details', { class: 'thinking', hidden: !m.thinking });
  const thinkLabel = h('span', null, 'Thought process');
  const thinkBody = h('div', { class: 'think-body' }, m.thinking || '');
  think.append(h('summary', null, icon('chevron', 'chev'), thinkLabel), thinkBody);
  const body = h('div', { class: 'msg-body md' });
  const foot = h('div', { class: 'msg-foot' });
  el.append(h('div', { class: 'msg-head' }, h('img', { class: 'av', src: '/icon.svg', alt: '' }), m.model || 'Assistant'), think, body, tools, foot);
  const els = { el, think, thinkLabel, thinkBody, body, tools, foot };
  paintAssistant(m, els, isLast);
  if (m.pending && streaming && streaming.msg === m) streaming.els = els;
  return el;
}

function paintAssistant(m, els, isLast) {
  if (m.content) els.body.innerHTML = renderMarkdown(m.content);   // renderMarkdown escapes all model output
  else if (m.pending) {
    clear(els.body).append(h('div', { class: 'status-line' }, h('span', { class: 'pulse' }, h('i'), h('i'), h('i')),
      m.thinking ? 'Thinking…' : (m.model && !S.running.some((r) => r.name === m.model) ? 'Loading ' + m.model + ' onto your hardware…' : '')));
  } else clear(els.body);
  els.think.hidden = !m.thinking;
  els.thinkBody.textContent = m.thinking || '';
  els.thinkLabel.textContent = m.pending && !m.content ? 'Thinking…' : 'Thought process';

  const oldErr = els.el.querySelector('.msg-error');
  if (oldErr) oldErr.remove();
  if (m.error) els.el.insertBefore(h('div', { class: 'msg-error' }, icon('alert'), h('div', null, m.error)), els.foot);

  clear(els.tools);
  els.tools.hidden = !(m.tools && m.tools.length);
  if (!els.tools.hidden) els.tools.append(...toolRows(m.tools, decide));

  clear(els.foot);
  if (m.pending) return;
  if (!m.content && !m.error && m.tools && m.tools.length && !isLast) return;   // a pure action step needs no footer
  if (m.content) els.foot.append(h('button', { class: 'iconbtn', title: 'Copy', onClick: (e) => copied(e.currentTarget, m.content) }, icon('copy', 'sm')));
  if (isLast && !streaming) els.foot.append(h('button', { class: 'iconbtn', title: 'Try again', onClick: regenerate }, icon('refresh', 'sm')));
  const s = m.stats;
  const bits = [];
  if (s && s.tps) bits.push(s.tps.toFixed(1) + ' tokens/s');
  if (s && s.tokens) bits.push(fmtCount(s.tokens) + ' tokens');
  if (m.stopped) bits.push('stopped');
  if (bits.length) els.foot.append(h('span', { class: 'stats' }, bits.join(' · ')));
}

async function copied(btn, text) {
  if (await copyText(text)) {
    clear(btn).append(icon('check', 'sm'));
    setTimeout(() => clear(btn).append(icon('copy', 'sm')), 1100);
  }
}

function onThreadClick(e) {
  const btn = e.target.closest('[data-copy-code]');
  if (!btn) return;
  const code = btn.closest('.codeblock').querySelector('pre code');
  copyText(code.textContent).then((ok) => {
    if (!ok) return;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1100);
  });
}

// ------------------------------------------------------------------ composer

function drawComposer() {
  if (!ui) return;
  clear(ui.chips);
  ui.chips.hidden = !attachments.length;
  for (const a of attachments) {
    ui.chips.append(h('span', { class: 'chip', title: a.path + ' — ' + fmtCount(Math.ceil(a.content.length / 3.6)) + ' tokens (approx.)' },
      icon('file', 'sm'), h('span', null, baseName(a.path)),
      h('button', { title: 'Remove', onClick: () => { attachments = attachments.filter((x) => x !== a); drawComposer(); } }, icon('x', 'sm'))));
  }
  const model = currentModel();
  const canThink = hasCap(model, 'thinking');
  ui.thinkBtn.hidden = !canThink;
  ui.thinkBtn.classList.toggle('on', canThink && S.settings.think !== false);
  ui.toolsBtn.hidden = !toolsAvailable();
  ui.toolsBtn.classList.toggle('on', toolsEnabled());
  drawMeter();
  drawSend();
}

function drawSend() {
  if (!ui) return;
  clear(ui.send);
  ui.send.classList.toggle('stop', !!streaming);
  ui.send.title = streaming ? 'Stop' : 'Send (Enter)';
  ui.send.append(icon(streaming ? 'stop' : 'send', streaming ? 'solid' : ''));
  ui.send.disabled = !streaming && (!currentModel() || (!ui.input.value.trim() && !attachments.length));
}

function numCtx() {
  const want = S.settings.numCtx || 8192;
  const m = modelInfo(currentModel());
  return m && m.context ? Math.min(want, m.context) : want;
}

function estimateTokens() {
  let chars = ui ? ui.input.value.length : 0;
  for (const a of attachments) chars += a.content.length + 40;
  if (S.project && S.project.systemPrompt) chars += S.project.systemPrompt.length;
  if (S.chat) for (const m of S.chat.messages) {
    chars += (m.content || '').length;
    if (m.files) for (const f of m.files) chars += f.content.length + 40;
    if (m.tools) for (const t of m.tools) chars += String(t.result || '').length + JSON.stringify(t.args || {}).length + 40;
  }
  return Math.ceil(chars / 3.6);
}

function drawMeter() {
  if (!ui) return;
  const limit = numCtx();
  const used = estimateTokens();
  const pct = Math.min(100, (used / limit) * 100);
  clear(ui.meter);
  ui.meter.classList.toggle('warn', used > limit * 0.85);
  ui.meter.title = used > limit * 0.85
    ? 'This conversation is close to or beyond the context window, so the model may lose the earliest parts. Raise it in chat settings.'
    : 'Approximate share of the model\'s context window in use.';
  ui.meter.append(h('span', { class: 'bar' }, h('i', { style: { width: pct + '%' } })), fmtTokens(used) + ' / ' + fmtTokens(limit));
  ui.meter.hidden = used < 200;
}

async function toggleThink() {
  S.settings.think = S.settings.think === false;
  drawComposer();
  try { await api('/api/settings', { body: { think: S.settings.think } }); } catch (e) { fail(e); }
}

function addAttachment(path, content) {
  let text = content;
  if (text.length > MAX_ATTACH_CHARS) {
    text = text.slice(0, MAX_ATTACH_CHARS) + '\n… (truncated)';
    toast(baseName(path) + ' is very large, so only the first part was attached.', 'warn');
  }
  const existing = attachments.find((a) => a.path === path);
  if (existing) existing.content = text; else attachments.push({ path, content: text });
  drawComposer();
  if (ui) ui.input.focus();
}

function openAttach(anchor) {
  if (!S.project.path) {
    menu(anchor, [
      { note: 'Link a folder to this project to attach its files as context.' },
      { label: 'Link a folder…', icon: 'link', onClick: () => emit('edit-project', S.project.id) },
    ]);
    return;
  }
  const search = h('input', { class: 'input', placeholder: 'Find a file to attach…', spellcheck: false });
  const list = h('div', { class: 'pop-list' });
  let seq = 0, timer = 0;
  const run = async () => {
    const my = ++seq;
    try {
      const results = await findFiles(search.value.trim());
      if (my !== seq) return;
      clear(list);
      if (!results.length) list.append(h('div', { class: 'empty-note' }, 'No matching files.'));
      for (const f of results.slice(0, 40)) {
        const on_ = attachments.some((a) => a.path === f.path);
        list.append(h('button', { class: 'opt', onClick: () => { closePop(); attachPath(f.path); } },
          icon('file'),
          h('div', { class: 'o-main' }, h('div', { class: 'o-title' }, f.name), h('div', { class: 'o-sub' }, dirName(f.path) || '(project root)')),
          on_ ? icon('check', 'check') : null));
      }
    } catch (e) { clear(list).append(h('div', { class: 'empty-note' }, e.message)); }
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = list.querySelector('button.opt'); if (b) b.click(); } });
  const p = popover(anchor, [h('div', { class: 'pop-search' }, search), list]);
  p.el.style.width = '380px';
  p.el.style.maxHeight = '380px';
  run();
  search.focus();
}

// ------------------------------------------------------------------ settings popover

function openSettings(anchor) {
  const model = modelInfo(currentModel());
  const max = model && model.context ? model.context : 0;
  const sizes = [4096, 8192, 16384, 32768, 65536, 131072].filter((n) => !max || n <= max);
  if (max && !sizes.includes(max)) sizes.push(max);
  const cur = S.settings.numCtx || 8192;
  const ctx = h('select', { class: 'select' }, sizes.map((n) => h('option', { value: String(n), selected: n === cur }, Math.round(n / 1024) + 'K tokens' + (n === max ? ' (model maximum)' : ''))));
  if (!sizes.includes(cur)) ctx.value = String(sizes[Math.min(1, sizes.length - 1)]);
  ctx.addEventListener('change', async () => {
    S.settings.numCtx = parseInt(ctx.value, 10);
    drawMeter();
    try { await api('/api/settings', { body: { numCtx: S.settings.numCtx } }); } catch (e) { fail(e); }
  });

  const temps = [['', 'Model default'], ['0.2', 'Precise'], ['0.7', 'Balanced'], ['1', 'Creative']];
  const curT = typeof S.settings.temperature === 'number' ? String(S.settings.temperature) : '';
  const temp = h('select', { class: 'select' }, temps.map(([v, l]) => h('option', { value: v, selected: v === curT }, l)));
  temp.addEventListener('change', async () => {
    S.settings.temperature = temp.value === '' ? null : parseFloat(temp.value);
    try { await api('/api/settings', { body: { temperature: S.settings.temperature } }); } catch (e) { fail(e); }
  });

  const sys = h('textarea', { class: 'textarea', placeholder: 'e.g. You are a careful senior engineer. Answer concisely.', spellcheck: false });
  sys.value = S.project.systemPrompt || '';
  sys.addEventListener('change', async () => {
    S.project.systemPrompt = sys.value;
    try { await api('/api/projects/update', { body: { id: S.project.id, systemPrompt: sys.value } }); } catch (e) { fail(e); }
  });

  popover(anchor, [
    h('div', { class: 'field' }, h('label', null, 'Context window'), ctx,
      h('div', { class: 'hint' }, 'How much conversation and file text the model can see at once. Larger windows use more memory and can be slower.')),
    h('div', { class: 'field' }, h('label', null, 'Style'), temp),
    h('div', { class: 'field' }, h('label', null, 'Instructions for "' + S.project.name + '"'), sys,
      h('div', { class: 'hint' }, 'Sent at the start of every chat in this project.')),
  ], { align: 'right', cls: 'settings-pop' });
}

// ------------------------------------------------------------------ generation

const MAX_TOOL_ROUNDS = 12;
let approval = null;        // { tool, resolve } while a change is waiting for the user's answer

/** File tools are offered only when the model supports them and the project has a folder. */
function toolsAvailable() {
  return !!(S.project && S.project.path && !S.project.missing && hasCap(currentModel(), 'tools'));
}
function toolsEnabled() { return toolsAvailable() && S.settings.fileTools !== false; }

async function toggleTools() {
  S.settings.fileTools = S.settings.fileTools === false;
  drawComposer();
  try { await api('/api/settings', { body: { fileTools: S.settings.fileTools } }); } catch (e) { fail(e); }
}

function decide(tool, allowed) {
  if (approval && approval.tool === tool) approval.resolve(allowed);
}

function buildMessages(chat, useTools) {
  const out = [];
  const sys = [(S.project.systemPrompt || '').trim(), useTools ? TOOL_PROMPT : ''].filter(Boolean).join('\n\n');
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of chat.messages) {
    if (m.pending) continue;
    if (m.role === 'assistant' && m.tools && m.tools.length) {
      // Replay what the model asked for and what came back, so it can carry on from there.
      out.push({ role: 'assistant', content: m.content || '', tool_calls: m.tools.map((t) => ({ function: { name: t.name, arguments: t.args || {} } })) });
      for (const t of m.tools) out.push({ role: 'tool', tool_name: t.name, content: String(t.result || 'This action was not run.') });
      continue;
    }
    if (m.role === 'user') {
      let content = m.content || '';
      if (m.files && m.files.length) {
        const blocks = m.files.map((f) => '<file path="' + f.path + '">\n' + f.content + '\n</file>').join('\n\n');
        content = blocks + '\n\n' + (content || 'Please review the attached file' + (m.files.length > 1 ? 's' : '') + '.');
      }
      out.push({ role: 'user', content });
    } else if (m.content) {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return out;
}

async function sendMessage() {
  if (streaming || !ui) return;
  const text = ui.input.value.trim();
  if (!text && !attachments.length) return;
  const model = currentModel();
  if (!model) { toast('Install a local model first.', 'warn'); openHub('discover'); return; }

  if (!S.chat) {
    const basis = text || baseName(attachments[0].path);
    S.chat = { id: uid('c'), title: basis.replace(/\s+/g, ' ').slice(0, 60), model, created: Date.now(), updated: Date.now(), messages: [], projectId: S.project.id };
    rememberChat(S.chat.id);
  }
  S.chat.model = model;
  S.chat.messages.push({ role: 'user', content: text, files: attachments.map((a) => ({ path: a.path, content: a.content })) });
  attachments = [];
  ui.input.value = '';
  ui.autosize();
  await generate();
}

async function regenerate() {
  if (streaming || !S.chat) return;
  const msgs = S.chat.messages;
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
  if (!msgs.length) return;
  await generate();
}

/**
 * One turn of the assistant. Normally that is a single reply; when the model asks to use file tools
 * it becomes a loop: reply -> run the requested actions (changes wait for approval) -> reply again.
 */
async function generate() {
  const chat = S.chat;
  const model = currentModel();
  const useTools = toolsEnabled();
  const ctl = new AbortController();
  streaming = { ctl, msg: null, els: null };
  let last = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const payload = { model, messages: buildMessages(chat, useTools), options: { num_ctx: numCtx() } };
    if (typeof S.settings.temperature === 'number') payload.options.temperature = S.settings.temperature;
    if (hasCap(model, 'thinking')) payload.think = S.settings.think !== false;
    if (useTools) payload.tools = TOOL_SCHEMAS;

    const msg = { role: 'assistant', content: '', thinking: '', model, pending: true };
    chat.messages.push(msg);
    streaming.msg = msg; streaming.els = null;
    if (S.chat === chat) drawAll();
    saveChat(chat);

    await streamReply(chat, msg, payload, ctl);
    last = msg;
    if (msg.error || msg.stopped || !msg.tools || !msg.tools.length) break;
    await runTools(chat, msg, ctl);
    await saveChat(chat);
    if (ctl.signal.aborted) break;
    if (round === MAX_TOOL_ROUNDS - 1) msg.error = 'Stopped here after ' + MAX_TOOL_ROUNDS + ' steps in a row. Send a message to let it continue.';
  }

  const els = streaming.els;
  streaming = null;
  approval = null;
  if (S.chat === chat) {
    if (els && last) paintAssistant(last, els, true);
    drawComposer();
  }
  await saveChat(chat);
  refreshModels();
}

/** Runs what the model asked for, one action at a time. Anything that changes files waits for Allow / Deny. */
async function runTools(chat, msg, ctl) {
  const repaint = () => {
    if (S.chat !== chat || !streaming || !streaming.els) return;
    const box = ui.messages;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    paintAssistant(msg, streaming.els, true);
    if (stick) box.scrollTop = box.scrollHeight;
  };
  for (const t of msg.tools) {
    const spec = TOOLS[t.name];
    if (ctl.signal.aborted) { t.status = 'cancelled'; t.result = 'Cancelled by the user.'; continue; }
    if (!spec) { t.status = 'error'; t.result = 'Error: there is no tool named ' + t.name + '.'; continue; }
    if (spec.prepare) {
      // Work out exactly what would change (and fail early, without asking, if it cannot be done).
      try { t.prep = await spec.prepare(t.args || {}); }
      catch (e) { t.status = 'error'; t.result = 'Error: ' + (e.message || String(e)); repaint(); continue; }
    }
    if (spec.write) {
      t.status = 'pending';
      repaint();
      const allowed = await new Promise((resolve) => { approval = { tool: t, resolve }; });
      approval = null;
      if (!allowed) {
        const cancelled = ctl.signal.aborted;
        t.status = cancelled ? 'cancelled' : 'denied';
        t.result = cancelled ? 'Cancelled by the user.' : 'The user declined this action. Do not retry it unless they ask.';
        repaint();
        continue;
      }
    }
    t.status = 'running';
    repaint();
    try { t.result = await spec.run(t.args || {}, t.prep); t.status = 'done'; }
    catch (e) { t.status = 'error'; t.result = 'Error: ' + (e.message || String(e)); }
    repaint();
  }
  repaint();
}

async function streamReply(chat, msg, payload, ctl) {
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (S.chat !== chat || !streaming || !streaming.els) return;
    const box = ui.messages;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    paintAssistant(msg, streaming.els, true);
    if (stick) box.scrollTop = box.scrollHeight;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  try {
    const res = await api('/api/chat', { body: payload, signal: ctl.signal, stream: true });
    let opened = false, closed = false;
    for await (const ev of ndjson(res)) {
      if (ev.error) throw new Error(ev.error);
      const part = ev.message || {};
      if (part.thinking) {
        msg.thinking += part.thinking;
        if (!opened && streaming.els) { streaming.els.think.open = true; opened = true; }
      }
      if (part.content) {
        msg.content += part.content;
        if (!closed && streaming.els) { streaming.els.think.open = false; closed = true; }
      }
      if (Array.isArray(part.tool_calls)) {
        for (const call of part.tool_calls) {
          const f = (call && call.function) || {};
          let args = f.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          if (f.name) (msg.tools || (msg.tools = [])).push({ name: f.name, args: args && typeof args === 'object' ? args : {}, status: 'queued', result: '' });
        }
      }
      if (ev.done) {
        const tokens = ev.eval_count || 0;
        msg.stats = { tokens, promptTokens: ev.prompt_eval_count || 0, tps: ev.eval_duration ? tokens / (ev.eval_duration / 1e9) : 0 };
        chat.ctxUsed = (ev.prompt_eval_count || 0) + tokens;
      }
      schedule();
    }
    if (!msg.content && !msg.thinking && !(msg.tools && msg.tools.length)) msg.error = 'The model returned an empty reply. Try again, or pick a different model.';
  } catch (e) {
    if (e.name === 'AbortError') msg.stopped = true;
    else msg.error = e.message;
  }

  msg.pending = false;
  if (raf) cancelAnimationFrame(raf);
  if (msg.stopped && msg.tools) for (const t of msg.tools) { t.status = 'cancelled'; t.result = 'Cancelled by the user.'; }
  if (S.chat === chat && streaming && streaming.els) paintAssistant(msg, streaming.els, true);
}

function stop() {
  if (!streaming) return;
  streaming.ctl.abort();
  if (approval) approval.resolve(false);
}

// ------------------------------------------------------------------ events

on('attach-file', ({ path, content }) => addAttachment(path, content));
on('model-chosen', () => { drawTopbar(); drawComposer(); if (S.chat && S.chat.messages.length && !streaming) saveChat(); });
on('models', () => { drawTopbar(); drawBanner(); drawComposer(); if (!S.chat || !S.chat.messages.length) drawMessages(); });
on('pane', () => drawTopbar());
on('project', async () => {
  stop();
  S.chat = null;
  attachments = [];
  await loadChats();
  await restoreChat();
});
