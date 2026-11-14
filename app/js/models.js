// Models: what is installed, which one is in use, the online catalog, and downloads.

import { h, icon, api, ndjson, S, emit, on, fmtBytes, fmtMem, fmtCount, toast, fail, modal, popover, closePop, confirmDialog, fitFor, clear } from './util.js';

// ------------------------------------------------------------------ state

export async function refreshModels() {
  try {
    const r = await api('/api/models');
    S.models = r.models; S.blocked = r.blocked; S.running = r.running;
    S.ollama.running = true;
  } catch (e) {
    S.models = []; S.running = [];
    try { S.ollama = await api('/api/ollama/status'); } catch {}
  }
  emit('models');
}

export function modelInfo(name) { return S.models.find((m) => m.name === name) || null; }

export function currentModel() {
  const wanted = [S.chat && S.chat.model, S.project && S.project.model, S.settings.defaultModel];
  for (const w of wanted) if (w && modelInfo(w)) return w;
  return S.models.length ? S.models[0].name : '';
}

export function hasCap(name, cap) {
  const m = modelInfo(name);
  return !!(m && m.capabilities && m.capabilities.includes(cap));
}

export async function chooseModel(name) {
  if (S.chat) S.chat.model = name;
  S.settings.defaultModel = name;
  if (S.project) S.project.model = name;
  emit('model-chosen', name);
  try {
    await api('/api/settings', { body: { defaultModel: name } });
    if (S.project) await api('/api/projects/update', { body: { id: S.project.id, model: name } });
  } catch (e) { fail(e); }
}

function isInstalled(name) {
  const n = name.toLowerCase();
  return S.models.some((m) => { const k = m.name.toLowerCase(); return k === n || k === n + ':latest' || k + ':latest' === n; });
}

function runningInfo(name) { return S.running.find((r) => r.name === name) || null; }

function processorLabel(r) {
  if (!r || !r.size) return '';
  const gpu = Math.round((r.vram / r.size) * 100);
  if (gpu >= 100) return '100% GPU';
  if (gpu <= 0) return '100% CPU';
  return gpu + '% GPU / ' + (100 - gpu) + '% CPU';
}

function capBadges(caps) {
  return (caps || []).filter((c) => c !== 'completion').map((c) => h('span', { class: 'badge' }, c));
}

// ------------------------------------------------------------------ model picker

export function openModelPicker(anchor) {
  const search = h('input', { class: 'input', placeholder: 'Find an installed model…', spellcheck: false });
  const listEl = h('div', { class: 'pop-list' });
  const cur = currentModel();

  const render = () => {
    clear(listEl);
    const q = search.value.trim().toLowerCase();
    const items = S.models.filter((m) => !q || m.name.toLowerCase().includes(q));
    for (const m of items) {
      const run = runningInfo(m.name);
      listEl.append(h('button', { class: 'opt', onClick: () => { closePop(); chooseModel(m.name); } },
        h('div', { class: 'o-main' },
          h('div', { class: 'o-title' }, h('span', { class: 'truncate' }, m.name), run ? h('span', { class: 'badge ok', title: 'Loaded in memory' }, processorLabel(run) || 'Loaded') : null),
          h('div', { class: 'o-sub' }, [m.params, m.quant, fmtBytes(m.size), ...(m.capabilities || []).filter((c) => c !== 'completion')].filter(Boolean).join(' · '))),
        m.name === cur ? icon('check', 'check') : null));
    }
    if (!items.length) listEl.append(h('div', { class: 'empty-note' }, S.models.length ? 'No installed model matches.' : 'No local models installed yet.'));
    if (!q && S.blocked.length) {
      listEl.append(h('div', { class: 'menu-sep' }));
      for (const b of S.blocked) {
        listEl.append(h('div', { class: 'opt disabled', title: b.reason },
          icon('lock'),
          h('div', { class: 'o-main' }, h('div', { class: 'o-title' }, b.name), h('div', { class: 'o-sub' }, 'Blocked — ' + b.reason))));
      }
    }
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = listEl.querySelector('button.opt'); if (first) first.click(); }
  });
  render();
  const p = popover(anchor, [
    h('div', { class: 'pop-search' }, search),
    listEl,
    h('div', { class: 'pop-foot' }, h('button', { class: 'menu-item', onClick: () => { closePop(); openHub('discover'); } }, icon('download'), 'Get more models…')),
  ], { align: 'right' });
  p.el.style.width = '380px';
  search.focus();
}

// ------------------------------------------------------------------ downloads

export const downloads = new Map();
export function activeDownloads() { return [...downloads.values()].filter((d) => d.state === 'active').length; }

let dlTick = 0;
function dlChanged(force) {
  const now = performance.now();
  if (!force && now - dlTick < 150) return;
  dlTick = now;
  emit('downloads');
}

export function startPull(name) {
  const existing = downloads.get(name);
  if (existing && existing.state === 'active') return;
  const d = { name, state: 'active', status: 'Starting…', layers: new Map(), completed: 0, total: 0, speed: 0, ctl: new AbortController(), lastT: performance.now(), lastB: 0, error: '' };
  downloads.set(name, d);
  dlChanged(true);
  (async () => {
    try {
      const res = await api('/api/models/pull', { body: { name }, signal: d.ctl.signal, stream: true });
      for await (const ev of ndjson(res)) {
        if (ev.error) throw new Error(ev.error);
        if (ev.status) d.status = ev.status;
        if (ev.digest && ev.total) {
          d.layers.set(ev.digest, { total: ev.total, completed: ev.completed || 0 });
          let c = 0, t = 0;
          for (const l of d.layers.values()) { c += l.completed; t += l.total; }
          d.completed = c; d.total = t;
          const now = performance.now();
          if (now - d.lastT > 900) {
            const inst = ((c - d.lastB) / (now - d.lastT)) * 1000;
            d.speed = d.speed ? d.speed * 0.6 + inst * 0.4 : inst;
            d.lastT = now; d.lastB = c;
          }
        }
        if (ev.status === 'success') d.state = 'done';
        dlChanged(false);
      }
      if (d.state !== 'done') throw new Error('The download stopped before it finished. Start it again to resume.');
      toast(name + ' is ready to use.');
      await refreshModels();
    } catch (e) {
      if (e.name === 'AbortError') downloads.delete(name);
      else { d.state = 'error'; d.error = e.message; toast('Download failed: ' + e.message, 'error', 7000); }
    }
    dlChanged(true);
  })();
}

function downloadStatusText(d) {
  if (d.state === 'error') return d.error;
  if (d.state === 'done') return 'Installed';
  if (!d.total || !/^pulling [0-9a-f]/.test(d.status)) return d.status.replace(/^pulling manifest/, 'Fetching manifest…').replace(/^verifying.*/, 'Verifying…').replace(/^writing.*/, 'Finishing…');
  const parts = [fmtBytes(d.completed) + ' of ' + fmtBytes(d.total)];
  if (d.speed > 1000) {
    parts.push(fmtBytes(d.speed) + '/s');
    const left = (d.total - d.completed) / d.speed;
    if (isFinite(left) && left > 0) parts.push(left > 90 ? Math.round(left / 60) + ' min left' : Math.max(1, Math.round(left)) + ' s left');
  }
  return parts.join(' · ');
}

function renderDownloads(box) {
  clear(box);
  const list = [...downloads.values()];
  box.hidden = !list.length;
  for (const d of list) {
    const pct = d.state === 'done' ? 100 : d.total ? Math.min(100, (d.completed / d.total) * 100) : 0;
    const bar = h('div', { class: 'progress' + (d.state === 'active' && !d.total ? ' indeterminate' : '') }, h('i', { style: { width: pct + '%' } }));
    box.append(h('div', { class: 'dl ' + d.state },
      h('div', { class: 'dl-name' }, d.name),
      h('button', {
        class: 'btn ghost sm', onClick: () => {
          if (d.state === 'active') d.ctl.abort(); else { downloads.delete(d.name); dlChanged(true); }
        },
      }, d.state === 'active' ? 'Cancel' : 'Dismiss'),
      bar,
      h('div', { class: 'dl-status' }, downloadStatusText(d) + (d.state === 'active' && d.total ? ' · ' + Math.floor(pct) + '%' : ''))));
  }
}

function pullButton(name, bytes, source) {
  const wrap = h('span', { class: 'row', style: { justifyContent: 'flex-end' } });
  const draw = () => {
    clear(wrap);
    const d = downloads.get(name);
    if (isInstalled(name)) wrap.append(h('span', { class: 'badge ok' }, icon('check', 'sm'), 'Installed'));
    else if (d && d.state === 'active') wrap.append(h('span', { class: 'badge accent' }, d.total ? Math.floor((d.completed / d.total) * 100) + '%' : 'Starting'));
    else wrap.append(h('button', { class: 'btn sm primary', onClick: () => confirmPull(name, bytes, source || guessSource(name)) }, icon('download', 'sm'), 'Download'));
  };
  wrap._draw = draw;
  wrap.dataset.pull = '1';
  draw();
  return wrap;
}

function guessSource(name) {
  const bare = name.replace(/:[^/]*$/, '');
  const parts = bare.split('/');
  if (parts.length === 1 || parts[0] === 'library') return 'official';
  return /^(hf\.co|huggingface\.co)$/i.test(parts[0]) ? 'hf-other' : 'community';
}

const UNREVIEWED = { community: 'a community upload that Ollama has not reviewed', 'hf-other': 'from a Hugging Face publisher that is not verified' };

async function confirmPull(name, bytes, source) {
  if (UNREVIEWED[source]) {
    const ok = await confirmDialog({
      title: 'Download an unreviewed model?',
      message: h('div', { class: 'muted' }, h('span', { class: 'mono' }, name), ' is ' + UNREVIEWED[source] + '. It will still run only on this PC, but nobody vouches for how it behaves or what it was trained to do. Download it only if you trust the publisher.'),
      confirmLabel: 'Download anyway', danger: true,
    });
    if (!ok) return;
  }
  const fit = fitFor(bytes);
  if (fit && fit.kind === 'danger') {
    const ok = await confirmDialog({
      title: 'This model is larger than this PC can hold',
      message: name + ' is about ' + fmtBytes(bytes) + '. It will download, but it is unlikely to run well here. Download anyway?',
      confirmLabel: 'Download anyway',
    });
    if (!ok) return;
  }
  startPull(name);
}

const SOURCE_BADGE = {
  official: ['ok', 'Official', 'Published in the official Ollama library.'],
  community: ['warn', 'Community · unreviewed', 'Uploaded by an ollama.com user. Not reviewed by Ollama.'],
  'hf-trusted': ['ok', 'Trusted publisher', 'A verified organisation or well-known publisher on Hugging Face.'],
  'hf-other': ['warn', 'Unverified publisher', 'This Hugging Face publisher is not verified.'],
  other: ['warn', 'Unknown source', 'Hearth could not tell where this model came from.'],
};
function sourceBadge(source) {
  const b = SOURCE_BADGE[source];
  return b ? h('span', { class: 'badge ' + b[0], title: b[2] }, b[1]) : null;
}

const LEVELS = [
  ['official', 'Official only', 'Only models published in the official Ollama library appear.'],
  ['trusted', 'Trusted publishers', 'The official Ollama library, plus Hugging Face builds from verified organisations and well-known publishers.'],
  ['all', 'Everything', 'Also community uploads that nobody has reviewed. They are labelled, and you are asked before each download.'],
];

/** The security-level switch shown above both catalogs. The backend enforces the level; this only sets it. */
function sourceBar(rerun) {
  const wrap = h('div', { class: 'sourcebar' });
  const setLevel = async (id) => {
    if (id === S.sourceLevel) return;
    if (id === 'all') {
      const ok = await confirmDialog({
        title: 'Show unreviewed models?',
        message: 'Community uploads can be mislabelled, modified or low quality, and nobody has checked them. They will be clearly marked and you will be asked again before each download.',
        confirmLabel: 'Show everything',
      });
      if (!ok) return;
    }
    try {
      await api('/api/settings', { body: { sourceLevel: id } });
      S.sourceLevel = id;
      draw();
      rerun();
    } catch (e) { fail(e); }
  };
  const draw = () => {
    const cur = S.sourceLevel || 'trusted';
    clear(wrap).append(
      h('div', { class: 'sourcebar-row' }, icon('shield'), h('b', null, 'Model sources'),
        h('div', { class: 'seg' }, LEVELS.map(([id, label]) => h('button', { class: 'seg-btn' + (id === cur ? ' on' : ''), onClick: () => setLevel(id) }, label)))),
      h('div', { class: 'hint' }, LEVELS.find((l) => l[0] === cur)[2] + ' Cloud models, other download sites, gated repositories and anything a security scan has flagged are always blocked.'));
  };
  draw();
  return wrap;
}

function hiddenNote(count, what) {
  return h('div', { class: 'hub-note' }, icon('lock'), h('div', null, count + ' ' + what + (count === 1 ? ' is' : ' are') + ' hidden at this security level.'));
}

function fitBadge(bytes) {
  const f = fitFor(bytes);
  return f ? h('span', { class: 'badge ' + f.kind, title: f.title }, f.label) : h('span');
}

// ------------------------------------------------------------------ hub

let hub = null;

export function openHub(tab = 'installed') {
  if (hub) { hub.show(tab); return; }
  const tabsEl = h('div', { class: 'hub-tabs' });
  const bodyEl = h('div', { class: 'hub-body' });
  const dlEl = h('div', { class: 'downloads', hidden: true });
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, tabsEl, bodyEl, dlEl);
  const state = { tab, discover: { q: '', caps: new Set(), size: '', sort: 'popular' }, hf: { q: '', sort: 'downloads' } };

  const tabs = [['installed', 'Installed', 'cube'], ['discover', 'Discover', 'search'], ['hf', 'Hugging Face', 'globe']];
  const show = (t) => {
    state.tab = t;
    clear(tabsEl);
    for (const [id, label, ic] of tabs)
      tabsEl.append(h('button', { class: 'hub-tab' + (id === t ? ' on' : ''), onClick: () => show(id) }, icon(ic), label,
        id === 'installed' ? h('span', { class: 'badge' }, S.models.length) : null));
    clear(bodyEl);
    if (t === 'installed') renderInstalled(bodyEl);
    else if (t === 'discover') renderDiscover(bodyEl, state.discover);
    else renderHf(bodyEl, state.hf);
  };

  const m = modal({ title: 'Models', size: 'wide', body: wrap, onClose: () => { hub = null; } });
  hub = { show, state, bodyEl, dlEl, modal: m };
  renderDownloads(dlEl);
  show(tab);
  refreshModels();
}

function defaultSizeFilter() {
  const gb = S.hardware.vram / 1e9;
  if (!gb) return '';
  return gb >= 60 ? '64' : gb >= 30 ? '32' : gb >= 15 ? '16' : '8';
}

on('downloads', () => {
  if (!hub) return;
  renderDownloads(hub.dlEl);
  hub.bodyEl.querySelectorAll('[data-pull]').forEach((el) => el._draw && el._draw());
});
on('models', () => {
  if (!hub) return;
  if (hub.state.tab === 'installed') hub.show('installed');
  else {
    hub.bodyEl.querySelectorAll('[data-pull]').forEach((el) => el._draw && el._draw());
    const b = hub.modal.el.querySelector('.hub-tab .badge');
    if (b) b.textContent = S.models.length;
  }
});

function hardwareNote() {
  const hw = S.hardware;
  if (!hw.vram && !hw.ram) return null;
  return h('div', { class: 'hub-note' }, icon('cpu'),
    h('div', null, h('b', null, 'This PC: '), [hw.gpu, hw.vram ? fmtMem(hw.vram) + ' GPU memory' : '', hw.ram ? fmtMem(hw.ram) + ' RAM' : ''].filter(Boolean).join(' · '),
      '. Size hints next to each download are based on this.'));
}

function renderInstalled(body) {
  if (!S.ollama.running) {
    body.append(h('div', { class: 'hub-empty' }, 'Ollama is not running, so installed models cannot be listed.'));
    return;
  }
  const hw = hardwareNote();
  if (hw) body.append(hw);
  if (!S.models.length) {
    body.append(h('div', { class: 'hub-empty' }, h('div', null, 'No local models yet.'),
      h('button', { class: 'btn primary', style: { marginTop: '12px' }, onClick: () => hub.show('discover') }, icon('search'), 'Find a model to download')));
  }
  const cur = currentModel();
  for (const m of S.models) {
    const run = runningInfo(m.name);
    body.append(h('div', { class: 'card installed-row' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, m.name,
          m.name === cur ? h('span', { class: 'badge accent' }, 'In use') : null,
          m.source && m.source !== 'official' ? sourceBadge(m.source) : null,
          run ? h('span', { class: 'badge ok', title: 'Currently loaded in memory' }, 'Loaded · ' + processorLabel(run)) : null),
        h('div', { class: 'sub' },
          h('span', null, [m.params, m.quant, fmtBytes(m.size), m.context ? fmtCount(m.context) + ' context' : ''].filter(Boolean).join(' · ')),
          capBadges(m.capabilities))),
      h('div', { class: 'row' },
        m.name !== cur ? h('button', { class: 'btn sm', onClick: () => { chooseModel(m.name); toast('Now using ' + m.name); hub.show('installed'); } }, 'Use') : null,
        run ? h('button', { class: 'btn sm ghost', title: 'Free the memory this model is using', onClick: async () => {
          try { await api('/api/models/unload', { body: { name: m.name } }); setTimeout(refreshModels, 700); } catch (e) { fail(e); }
        } }, icon('eject', 'sm'), 'Unload') : null,
        h('button', { class: 'iconbtn', title: 'Delete this model from disk', onClick: () => deleteModel(m.name, fmtBytes(m.size)) }, icon('trash')))));
  }
  if (S.blocked.length) {
    body.append(h('div', { class: 'sb-section', style: { padding: '10px 2px 0' } }, 'Blocked — not local'));
    for (const b of S.blocked) {
      body.append(h('div', { class: 'card installed-row blocked' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, icon('lock'), b.name, h('span', { class: 'badge warn' }, 'Cloud')),
          h('div', { class: 'sub' }, b.reason + '. Hearth will not send anything to it.')),
        h('button', { class: 'btn sm ghost', onClick: () => deleteModel(b.name, '') }, icon('trash', 'sm'), 'Remove')));
    }
  }
}

async function deleteModel(name, size) {
  const ok = await confirmDialog({
    title: 'Delete ' + name + '?',
    message: 'This removes the model from Ollama' + (size ? ' and frees about ' + size : '') + '. You can download it again later.',
    confirmLabel: 'Delete model', danger: true,
  });
  if (!ok) return;
  try { await api('/api/models/delete', { body: { name } }); toast(name + ' was deleted.'); }
  catch (e) { fail(e); }
  refreshModels();
}

// ---- Discover (ollama.com)

function renderDiscover(body, st) {
  const input = h('input', { class: 'input', placeholder: 'Search the Ollama library — try "coder", "vision", "qwen"…', value: st.q, spellcheck: false });
  const size = h('select', { class: 'select', title: 'Largest download size' },
    [['', 'Any size'], ['8', 'Up to 8 GB'], ['16', 'Up to 16 GB'], ['32', 'Up to 32 GB'], ['64', 'Up to 64 GB']].map(([v, l]) => h('option', { value: v, selected: v === st.size }, l)));
  const sort = h('select', { class: 'select', title: 'Sort' },
    [['popular', 'Most popular'], ['newest', 'Newest']].map(([v, l]) => h('option', { value: v, selected: v === st.sort }, l)));
  const chips = h('div', { class: 'filter-chips' });
  const results = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const moreHost = h('div', { style: { display: 'flex', justifyContent: 'center' } });
  let seq = 0, timer = 0, nextPage = 1, hiddenTotal = 0;

  const drawChips = () => {
    clear(chips);
    for (const c of ['tools', 'vision', 'thinking', 'embedding'])
      chips.append(h('button', { class: 'fchip' + (st.caps.has(c) ? ' on' : ''), onClick: () => { st.caps.has(c) ? st.caps.delete(c) : st.caps.add(c); drawChips(); run(); } }, c[0].toUpperCase() + c.slice(1)));
  };

  const run = async (append) => {
    const my = ++seq;
    st.q = input.value.trim(); st.size = size.value; st.sort = sort.value;
    if (!append) { nextPage = 1; hiddenTotal = 0; clear(results).append(h('div', { class: 'loading-row' }, h('div', { class: 'spinner' }), 'Searching ollama.com…')); }
    clear(moreHost);
    if (append) moreHost.append(h('div', { class: 'loading-row', style: { padding: '8px' } }, h('div', { class: 'spinner' }), 'Loading more…'));
    try {
      const r = await api('/api/catalog/search', { query: { q: st.q, caps: [...st.caps].join(','), size: st.size, sort: st.sort, page: nextPage } });
      if (my !== seq) return;
      clear(moreHost);
      nextPage = r.page + 1;
      hiddenTotal += r.hidden || 0;
      const oldNote = results.querySelector('[data-hidden-note]');
      if (oldNote) oldNote.remove();
      if (append) {
        for (const item of r.results) results.append(catalogCard(item));
        if (!r.results.length && !r.more) toast('No more models to show.', 'warn');
      } else {
      clear(results);
      if (/^[\w.\-]+(\/[\w.\-]+)*(:[\w.\-]+)?$/.test(st.q) && st.q.length > 1 && !r.results.some((x) => x.name === st.q))
        results.append(h('div', { class: 'hub-note' }, icon('info'),
          h('div', { class: 'grow' }, 'Know the exact name? Download ', h('span', { class: 'mono' }, st.q), ' directly.'), pullButton(st.q, 0)));
      if (!r.results.length) results.append(h('div', { class: 'hub-empty' }, 'No models match. Try a broader search' + (st.size ? ' or a larger size limit' : '') + '.'));
      for (const item of r.results) results.append(catalogCard(item));
      }
      if (hiddenTotal) { const note = hiddenNote(hiddenTotal, 'community upload' + (hiddenTotal === 1 ? '' : 's')); note.dataset.hiddenNote = '1'; results.append(note); }
      if (r.more) moreHost.append(h('button', { class: 'btn', onClick: () => run(true) }, icon('down'), 'Load more models'));
    } catch (e) {
      if (my !== seq) return;
      clear(moreHost);
      if (append) fail(e); else clear(results).append(h('div', { class: 'hub-empty' }, e.message));
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(), 380); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  size.addEventListener('change', () => run());
  sort.addEventListener('change', () => run());
  drawChips();
  body.append(
    h('div', { class: 'hub-search' }, h('div', { class: 'searchbox' }, icon('search'), input), size, sort),
    chips,
    sourceBar(() => run()),
    results, moreHost);
  run();
  setTimeout(() => input.focus(), 40);
}

function catalogCard(item) {
  const card = h('div', { class: 'card mcard' });
  const variants = h('div', { class: 'variants', hidden: true });
  let loaded = false;
  const toggle = async () => {
    const open = card.classList.toggle('open');
    variants.hidden = !open;
    if (!open || loaded) return;
    loaded = true;
    variants.append(h('div', { class: 'loading-row' }, h('div', { class: 'spinner' }), 'Loading versions…'));
    try {
      const r = await api('/api/catalog/tags', { query: { name: item.name } });
      clear(variants);
      if (!r.tags.length) variants.append(h('div', { class: 'empty-note' }, 'No downloadable versions were found for this model.'));
      for (const t of r.tags)
        variants.append(h('div', { class: 'variant' },
          h('span', { class: 'vname', title: t.name }, t.name),
          h('span', { class: 'vsize' }, t.size),
          h('span', { class: 'faint' }, t.context ? t.context + ' ctx' : ''),
          h('span', { class: 'row' }, fitBadge(t.bytes), h('span', { class: 'faint truncate' }, t.input)),
          pullButton(t.name, t.bytes, item.source)));
      if (r.hiddenCloud) variants.append(h('div', { class: 'empty-note', style: { padding: '8px' } }, r.hiddenCloud + ' cloud-only version' + (r.hiddenCloud > 1 ? 's' : '') + ' hidden.'));
    } catch (e) {
      loaded = false;
      clear(variants).append(h('div', { class: 'empty-note' }, e.message));
    }
  };
  card.append(
    h('div', { class: 'mcard-head', onClick: toggle },
      h('span', { class: 'mcard-title' }, item.name),
      sourceBadge(item.source),
      item.capabilities.map((c) => h('span', { class: 'badge accent' }, c)),
      icon('chevron', 'chev')),
    item.description ? h('div', { class: 'mcard-desc' }, item.description) : null,
    h('div', { class: 'mcard-meta' },
      item.pulls ? h('span', null, fmtCount(item.pulls) + ' downloads') : null,
      item.updated ? h('span', null, '· updated ' + item.updated) : null,
      item.sizes.map((s) => h('span', { class: 'badge' }, s))),
    variants);
  return card;
}

// ---- Hugging Face (GGUF)

function renderHf(body, st) {
  const input = h('input', { class: 'input', placeholder: 'Search GGUF models on Hugging Face…', value: st.q, spellcheck: false });
  const sort = h('select', { class: 'select', title: 'Sort' },
    [['downloads', 'Most downloaded'], ['likes', 'Most liked'], ['recent', 'Recently updated']].map(([v, l]) => h('option', { value: v, selected: v === st.sort }, l)));
  const results = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  let seq = 0, timer = 0;
  const run = async () => {
    const my = ++seq;
    st.q = input.value.trim(); st.sort = sort.value;
    clear(results).append(h('div', { class: 'loading-row' }, h('div', { class: 'spinner' }), 'Searching huggingface.co and checking publishers…'));
    try {
      const r = await api('/api/catalog/hf', { query: { q: st.q, sort: st.sort } });
      if (my !== seq) return;
      clear(results);
      if (r.disabled) { results.append(h('div', { class: 'hub-empty' }, 'Hugging Face is switched off at the Official only level. Choose Trusted publishers above to browse it.')); return; }
      if (!r.results.length) results.append(h('div', { class: 'hub-empty' }, r.hidden ? 'Nothing from a trusted publisher matches.' : 'Nothing found.'));
      for (const item of r.results) results.append(hfCard(item));
      if (r.hidden) results.append(hiddenNote(r.hidden, 'result' + (r.hidden === 1 ? '' : 's') + ' from unverified publishers'));
    } catch (e) {
      if (my !== seq) return;
      clear(results).append(h('div', { class: 'hub-empty' }, e.message));
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 380); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  sort.addEventListener('change', run);
  body.append(
    h('div', { class: 'hub-search' }, h('div', { class: 'searchbox' }, icon('search'), input), sort),
    sourceBar(() => run()),
    results);
  run();
  setTimeout(() => input.focus(), 40);
}

function hfCard(item) {
  const card = h('div', { class: 'card mcard' });
  const variants = h('div', { class: 'variants', hidden: true });
  let loaded = false;
  const toggle = async () => {
    const open = card.classList.toggle('open');
    variants.hidden = !open;
    if (!open || loaded) return;
    loaded = true;
    variants.append(h('div', { class: 'loading-row' }, h('div', { class: 'spinner' }), 'Loading files…'));
    try {
      const r = await api('/api/catalog/hf-files', { query: { id: item.id } });
      clear(variants);
      if (r.blocked) { variants.append(h('div', { class: 'empty-note' }, icon('lock'), ' Blocked — ' + r.blocked)); return; }
      if (!r.tags.length) variants.append(h('div', { class: 'empty-note' }, 'No single-file GGUF builds were found in this repository.'));
      for (const t of r.tags)
        variants.append(h('div', { class: 'variant' },
          h('span', { class: 'vname', title: t.file }, t.tag),
          h('span', { class: 'vsize' }, fmtBytes(t.bytes)),
          h('span'),
          h('span', { class: 'row' }, fitBadge(t.bytes)),
          pullButton(t.name, t.bytes, item.source)));
      if (r.scanned) variants.append(h('div', { class: 'empty-note', style: { padding: '8px' } }, 'Hugging Face\'s security scan found no issues in this repository.'));
    } catch (e) {
      loaded = false;
      clear(variants).append(h('div', { class: 'empty-note' }, e.message));
    }
  };
  card.append(
    h('div', { class: 'mcard-head', onClick: toggle }, h('span', { class: 'mcard-title' }, item.id), sourceBadge(item.source), icon('chevron', 'chev')),
    h('div', { class: 'mcard-meta' },
      h('span', null, fmtCount(item.downloads) + ' downloads'),
      h('span', null, '· ' + fmtCount(item.likes) + ' likes'),
      item.license ? h('span', { class: 'badge' }, item.license) : null,
      item.task ? h('span', { class: 'badge' }, item.task) : null,
      item.baseModel ? h('span', null, '· from ' + item.baseModel) : null),
    variants);
  return card;
}

// ------------------------------------------------------------------ "local only" panel

export async function openLocalPanel() {
  await refreshModels();
  const o = S.ollama;
  const row = (kind, title, text) => h('div', { class: 'check-row ' + kind },
    h('div', { class: 'ci' }, icon(kind === 'bad' ? 'x' : kind === 'info' ? 'info' : 'check', 'sm')),
    h('div', null, h('b', null, title), h('span', null, text)));
  const run = S.running.map((r) => r.name + ' — ' + (processorLabel(r) || 'loaded') + (r.vram ? ' (' + fmtBytes(r.vram) + ' GPU memory)' : '')).join('; ');
  const body = h('div', { class: 'modal-body' }, h('div', { class: 'checklist' },
    o.running
      ? row('ok', 'AI runs on this PC', 'Every chat goes to Ollama at ' + o.endpoint + ', a loopback address that cannot leave this machine. A remote or proxied endpoint is refused.')
      : row('bad', 'Ollama is not running', 'Nothing can be generated until Ollama is started on this PC. Hearth will not fall back to any online service.'),
    o.warning ? row('bad', 'Remote Ollama setting ignored', o.warning) : null,
    row('ok', 'Cloud models are blocked',
      S.blocked.length
        ? 'Installed but blocked: ' + S.blocked.map((b) => b.name).join(', ') + '. Hearth refuses to chat with or download cloud-hosted models.'
        : 'No cloud-hosted models are installed. Hearth refuses to chat with or download them.'),
    row(S.running.length ? 'ok' : 'info', S.running.length ? 'In memory right now' : 'No model loaded right now',
      S.running.length ? run : 'A model loads onto your ' + (S.hardware.gpu || 'hardware') + ' when you send a message.'),
    row('ok', 'Model sources are restricted', 'Security level: ' + (LEVELS.find((l) => l[0] === (S.sourceLevel || 'trusted')) || LEVELS[1])[1] + '. Downloads come only from the Ollama library and Hugging Face, are checked against this level again at download time, and repositories flagged by a security scan are refused.'),
    row('ok', 'The interface cannot call out', 'This window is locked to Hearth\'s local service: no analytics, fonts, scripts or other outside connections.'),
    row('ok', 'Files stay inside guardrails', 'Hearth only touches the folder you link to a project. Credential files, .git and anything you protect are locked, nothing is overwritten, and deletes go to the Recycle Bin.'),
    row('info', 'When the internet is used', 'Only when you search for models (your search words go to ollama.com or huggingface.co) and when Ollama downloads a model you chose. Chats and files are never sent.')));
  modal({ title: 'Private by design', size: 'medium', body });
}
