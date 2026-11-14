// GitHub: sign in from inside Hearth and upload a project to your own account.
//
// Sign-in happens in GitHub's own window (opened by Git Credential Manager); this page never sees a
// password or token. Uploads run only when the button is pressed, default to a private repository,
// and leave out every protected file.

import { h, icon, api, ndjson, S, emit, clear, toast, fail, modal, confirmDialog } from './util.js';

export const github = { status: { git: false, signedIn: false, login: '' } };

export async function refreshGitHub() {
  try { github.status = await api('/api/github/status'); }
  catch { github.status = { git: false, signedIn: false, login: '' }; }
  emit('github');
  return github.status;
}

const openUrl = (url) => api('/api/open-url', { body: { url } }).catch(fail);

export function openGitHub() {
  const account = h('div', { class: 'card gh-card' });
  const project = h('div', { class: 'card gh-card' });
  const body = h('div', { class: 'modal-body' }, account, project,
    h('div', { class: 'hub-note' }, icon('shield'), h('div', null,
      'Protected files — credentials, keys, and anything you marked Protect — are never uploaded. Nothing leaves this PC until you press the upload button.')));
  modal({ title: 'GitHub', size: 'medium', body });

  const busyRow = (text) => h('div', { class: 'loading-row', style: { padding: '14px' } }, h('div', { class: 'spinner' }), text);

  // ---------------------------------------------------------------- account

  const drawAccount = () => {
    const st = github.status;
    clear(account);
    if (!st.git) {
      account.append(
        h('div', { class: 'gh-title' }, icon('alert'), 'Git for Windows is needed'),
        h('div', { class: 'muted' }, 'Hearth uses Git to sign in to GitHub and to upload projects. Install Git for Windows, then close and reopen Hearth.'),
        h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => openUrl('https://git-scm.com/download/win') }, icon('download'), 'Get Git for Windows')));
      return;
    }
    if (!st.signedIn) {
      const btn = h('button', { class: 'btn primary', onClick: async () => {
        clear(account).append(busyRow('Finish signing in in the GitHub window that opened…'));
        try {
          github.status = await api('/api/github/signin', { body: {} });
          emit('github');
          toast('Signed in to GitHub as ' + github.status.login + '.');
        } catch (e) { fail(e); }
        drawAccount(); drawProject();
      } }, 'Sign in with GitHub');
      account.append(
        h('div', { class: 'gh-title' }, 'Not signed in'),
        h('div', { class: 'muted' }, 'Sign in to upload projects from this PC to your GitHub account. GitHub\'s own sign-in window opens; Hearth never sees your password.'),
        h('div', { class: 'row' }, btn));
      return;
    }
    account.append(
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'gh-title' }, h('span', { class: 'dot ok' }), 'Signed in as ' + st.login),
          h('div', { class: 'muted' }, st.viaCli ? 'Using the GitHub CLI sign-in on this PC.' : 'Your sign-in is kept by Windows Credential Manager, not by Hearth.')),
        h('button', { class: 'btn sm ghost', onClick: async () => {
          try { github.status = await api('/api/github/signout', { body: {} }); emit('github'); toast('Signed out of GitHub.'); }
          catch (e) { fail(e); }
          drawAccount(); drawProject();
        } }, 'Sign out')));
  };

  // ---------------------------------------------------------------- project

  const runUpload = async (payload, log, done) => {
    clear(log);
    const line = (text, cls) => { const el = h('div', { class: 'gh-step ' + (cls || '') }, text); log.append(el); return el; };
    let last = null;
    try {
      const res = await api('/api/github/upload', { body: payload, stream: true });
      for await (const ev of ndjson(res)) {
        if (ev.step) { if (last) last.classList.add('ok'); last = line(ev.step, 'run'); }
        if (ev.error) { if (last) last.classList.remove('run'); line(ev.error, 'bad'); toast('Upload stopped.', 'error'); break; }
        if (ev.done) {
          if (last) { last.classList.remove('run'); last.classList.add('ok'); }
          line('Uploaded ' + ev.files + ' file' + (ev.files === 1 ? '' : 's') + ' (snapshot ' + ev.commit + ').', 'ok');
          toast('Project uploaded to GitHub.');
        }
      }
    } catch (e) { line(e.message, 'bad'); }
    log.querySelectorAll('.run').forEach((el) => el.classList.remove('run'));
    done();
  };

  const drawProject = async () => {
    const st = github.status;
    const p = S.project;
    clear(project);
    project.hidden = !st.git || !st.signedIn;
    if (project.hidden) return;
    project.append(h('div', { class: 'gh-title' }, icon('folder'), p.name));
    if (!p.path || p.missing) {
      project.append(h('div', { class: 'muted' }, 'Link a folder to this project to upload it.'),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onClick: () => emit('edit-project', p.id) }, icon('link', 'sm'), 'Link a folder')));
      return;
    }
    const holder = h('div', { class: 'gh-body' }, busyRow('Checking this project…'));
    project.append(holder);
    let ps;
    try { ps = await api('/api/github/project', { query: { project: p.id } }); }
    catch (e) { clear(holder).append(h('div', { class: 'muted' }, e.message)); return; }
    clear(holder);
    const log = h('div', { class: 'gh-log' });

    if (ps.nested) {
      holder.append(h('div', { class: 'muted' }, 'This folder is part of a larger Git repository, so Hearth will not upload it on its own.'), h('div', { class: 'mono' }, ps.top || ''));
      return;
    }

    if (ps.web) {
      const pending = (ps.changes || 0) + (parseInt(ps.unpushed, 10) || 0);
      const message = h('input', { class: 'input', placeholder: 'What changed? (optional)', spellcheck: true });
      const btn = h('button', { class: 'btn primary', onClick: () => { btn.disabled = true; runUpload({ project: p.id, message: message.value }, log, () => drawProject().then(() => project.append(log))); } },
        icon('upload'), 'Upload changes');
      holder.append(
        h('div', { class: 'row' }, h('div', { class: 'grow muted' }, 'Uploaded to ', h('span', { class: 'mono' }, ps.web.replace('https://', ''))),
          h('button', { class: 'btn sm ghost', onClick: () => openUrl(ps.web) }, icon('globe', 'sm'), 'Open on GitHub')),
        h('div', { class: 'muted' }, pending
          ? (ps.changes ? ps.changes + ' file' + (ps.changes === 1 ? ' has' : 's have') + ' changed since the last upload.' : 'There are saved snapshots that are not on GitHub yet.')
          : 'Everything is uploaded.'),
        pending ? h('div', { class: 'field' }, message) : null,
        pending ? h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, btn) : null,
        log);
      return;
    }
    if (ps.remote) {
      holder.append(h('div', { class: 'muted' }, 'This project is already connected to a Git server that is not GitHub, so Hearth will not upload it.'));
      return;
    }

    let isPrivate = true;
    const name = h('input', { class: 'input mono', value: ps.suggested || 'project', spellcheck: false });
    const desc = h('input', { class: 'input', placeholder: 'Short description (optional)' });
    const seg = h('div', { class: 'seg' });
    const drawSeg = () => clear(seg).append(
      h('button', { class: 'seg-btn' + (isPrivate ? ' on' : ''), onClick: () => { isPrivate = true; drawSeg(); } }, icon('lock', 'sm'), ' Private'),
      h('button', { class: 'seg-btn' + (!isPrivate ? ' on' : ''), onClick: () => { isPrivate = false; drawSeg(); } }, icon('globe', 'sm'), ' Public'));
    drawSeg();
    const btn = h('button', { class: 'btn primary', onClick: async () => {
      const repo = name.value.trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) { toast('Repository names can only use letters, numbers, dots, dashes and underscores.', 'warn'); return; }
      if (!isPrivate) {
        const ok = await confirmDialog({
          title: 'Make this project public?',
          message: 'Anyone on the internet will be able to see every uploaded file in ' + st.login + '/' + repo + '. You can switch a repository to private later on GitHub, but copies may already exist by then.',
          confirmLabel: 'Upload as public', danger: true,
        });
        if (!ok) return;
      }
      btn.disabled = true;
      runUpload({ project: p.id, name: repo, private: isPrivate, description: desc.value }, log, () => drawProject().then(() => project.append(log)));
    } }, icon('upload'), 'Upload to GitHub');

    holder.append(
      h('div', { class: 'muted' }, 'This project is not on GitHub yet. Hearth will create a new repository in your account and upload the folder to it.'),
      h('div', { class: 'field' }, h('label', null, 'Repository name'), h('div', { class: 'row' }, h('span', { class: 'faint mono' }, st.login + ' /'), h('div', { class: 'grow' }, name))),
      h('div', { class: 'field' }, h('label', null, 'Who can see it'), h('div', { class: 'row' }, seg,
        h('span', { class: 'hint' }, 'Private repositories are visible only to you and people you invite.'))),
      h('div', { class: 'field' }, h('label', null, 'Description'), desc),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, btn),
      log);
  };

  drawAccount();
  drawProject();
  refreshGitHub().then(() => { drawAccount(); drawProject(); });
}
