import { sanitizeHtml } from './html.js'

/** postMessage channel between the prototype iframe and Studio. */
export const GUI_SANDBOX_CHANNEL = 'agile-sofl-gui'

/**
 * Iframe sandbox tokens. Scripts may run.
 * Forms, popups, same-origin access, and top-level navigation stay disabled
 * so a prototype cannot reload or rewrite the Studio window.
 */
export const GUI_IFRAME_SANDBOX = 'allow-scripts'

const PRELUDE = `(function () {
  function deny() { throw new Error('disabled in GUI sandbox'); }
  function denyAsync() { return Promise.reject(new Error('disabled in GUI sandbox')); }
  window.fetch = denyAsync;
  window.XMLHttpRequest = deny;
  window.WebSocket = deny;
  window.EventSource = deny;
  window.open = function () { return null; };
  window.alert = function () {};
  window.confirm = function () { return false; };
  window.prompt = function () { return null; };
  try {
    ['assign', 'replace', 'reload'].forEach(function (name) {
      Object.defineProperty(Location.prototype, name, { configurable: true, value: function () {} });
    });
  } catch (e) {}
  document.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.closest && target.closest('a')) event.preventDefault();
  }, true);
})();`

function bridge(interactive: boolean): string {
  return `(function () {
  var interactive = ${interactive ? 'true' : 'false'};
  var channel = ${JSON.stringify(GUI_SANDBOX_CHANNEL)};
  function post(msg) {
    parent.postMessage(Object.assign({ channel: channel }, msg), '*');
  }
  function pathOf(target) {
    var app = document.querySelector('.as-app');
    if (!app || !target) return null;
    if (target === app) return '0';
    var parts = [];
    var el = target;
    while (el && el !== app) {
      var parentEl = el.parentElement;
      if (!parentEl) return null;
      parts.unshift(Array.prototype.indexOf.call(parentEl.children, el));
      el = parentEl;
    }
    return ['0'].concat(parts).join('.');
  }
  function collectEnv() {
    var env = {};
    document.querySelectorAll('[data-bind]').forEach(function (el) {
      var bind = el.getAttribute('data-bind') || '';
      var value = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
        ? (el.type === 'checkbox' ? el.checked : el.value)
        : (el.textContent || '').trim();
      bind.split('|').forEach(function (part) {
        var name = (part.split(':')[1] || '').trim();
        if (name) env[name] = value;
      });
    });
    return env;
  }
  function applyEnv(env) {
    document.querySelectorAll('[data-bind]').forEach(function (el) {
      var bind = el.getAttribute('data-bind') || '';
      var parts = bind.split('|').map(function (p) { return p.trim(); });
      var out = null;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.indexOf('out:') === 0 || p.indexOf('display:') === 0 || p.indexOf('var:') === 0) out = p;
      }
      if (!out) return;
      var name = out.split(':')[1];
      if (!name || !Object.prototype.hasOwnProperty.call(env, name)) return;
      var value = env[name];
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (el.type === 'checkbox') el.checked = Boolean(value);
        else el.value = value == null ? '' : String(value);
      } else {
        el.textContent = value == null ? '' : String(value);
      }
    });
  }
  document.querySelectorAll('button').forEach(function (btn) {
    if (!btn.getAttribute('type')) btn.setAttribute('type', 'button');
  });
  document.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('a')) event.preventDefault();
    var hit = target.closest('[data-process], [data-nav], [id], [data-screen], [data-bind]');
    var node = hit || target;
    var id = hit ? (hit.id || hit.getAttribute('data-id') || hit.getAttribute('data-screen') || null) : null;
    post({ type: 'select', id: id, path: pathOf(node) });
    if (!interactive) return;
    var nav = hit && hit.getAttribute('data-nav');
    var process = hit && hit.getAttribute('data-process');
    var screenEl = hit && hit.closest('[data-screen]');
    var screen = screenEl && screenEl.getAttribute('data-screen');
    if (nav) {
      event.preventDefault();
      post({ type: 'navigate', id: nav });
    }
    if (process) {
      event.preventDefault();
      post({
        type: 'process',
        process: process,
        env: collectEnv(),
        nav: nav || undefined,
        screen: screen || undefined
      });
    }
  }, true);
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== channel || data.type !== 'apply-env') return;
    applyEnv(data.env || {});
  });
  post({ type: 'ready' });
})();`
}

function escapeStyleClose(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

/** Build a srcdoc whose scripts cannot touch the parent Studio document. */
export function buildPrototypeSrcdoc(html: string, css: string, interactive = false): string {
  const body = sanitizeHtml(html || '').trim()
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:;">
<style>${escapeStyleClose(css)}</style>
<script>${PRELUDE}</script>
</head>
<body>
${body}
<script>${bridge(interactive)}</script>
</body>
</html>
`
}
