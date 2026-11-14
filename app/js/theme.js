// Applied before first paint so the window never flashes the wrong theme.
(function () {
  var t = null;
  try { t = localStorage.getItem('hearth.theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
