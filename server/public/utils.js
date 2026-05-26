'use strict';

export const $ = (id) => document.getElementById(id);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function tsNow() {
  const d = new Date();
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}]`;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, kind = 'info') {
  const tray = $('toastTray');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  tray.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function setStatus(text, ok = true) {
  const s = $('status'); if (s) s.textContent = text;
  const dot = $('serverState'); if (dot) dot.classList.toggle('connected', ok);
}
