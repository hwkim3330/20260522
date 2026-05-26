'use strict';
// HyperTerminal — Serial port terminal + status bar
import { $, api, toast, esc, pad2 } from './utils.js';
import { state } from './state.js';

export function updateStatusBar() {
  const pkts = state.captureRows.length;
  const serial = state.serialConnected ? '● Serial' : '○ Serial';
  const cap = state.captureTimer ? `● Cap ${pkts}pkts` : `○ Cap ${pkts}pkts`;
  const sb = $('statusExtra'); if (sb) sb.textContent = `${serial}   ${cap}`;
}

export function updateSerialUI(connected, statusText) {
  state.serialConnected = connected;
  updateStatusBar();
  const led = $('serialLed'), st = $('serialState');
  if (led) led.classList.toggle('connected', connected);
  const connectBtn = $('serialConnect'), disconnectBtn = $('serialDisconnect');
  if (connectBtn) { connectBtn.disabled = connected; connectBtn.style.opacity = connected ? '.5' : '1'; }
  if (disconnectBtn) { disconnectBtn.disabled = !connected; disconnectBtn.style.opacity = connected ? '1' : '.5'; }
  if (st && statusText !== undefined) st.textContent = statusText;
  const brk = $('serialBrk'); if (brk) brk.disabled = !connected;
}

export function appendHyperTerm(text) {
  const now = new Date(), ts = `[${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
  const line = `${ts}  ${text}\n`;
  const out = $('serialOutput');
  if (out) { if (out.textContent === 'No terminal output.') out.textContent = ''; out.textContent += line; out.scrollTop = out.scrollHeight; }
  const seq = $('seqTerminal');
  if (seq) { if (seq.textContent === 'No output.') seq.textContent = ''; seq.textContent += line; seq.scrollTop = seq.scrollHeight; }
}

let _ttyStreamCtrl = null;

export function startTtyStream(session) {
  if (_ttyStreamCtrl) _ttyStreamCtrl.abort();
  _ttyStreamCtrl = new AbortController();
  const url = `/api/tty/stream${session ? `?session=${encodeURIComponent(session)}` : ''}`;
  let buf = '';
  fetch(url, { signal: _ttyStreamCtrl.signal }).then(r => {
    const reader = r.body.getReader(), decoder = new TextDecoder();
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n'); buf = parts.pop() ?? '';
        for (const part of parts) {
          const s = part.trim(); if (!s) continue;
          try {
            const msg = JSON.parse(s);
            if (msg.type === 'rx' && msg.hex) {
              const bytes = Uint8Array.from(msg.hex.match(/.{1,2}/g) || [], b => parseInt(b, 16));
              const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
              text.split(/\r?\n/).filter(l => l.trim()).forEach(l => appendHyperTerm(l));
            } else if (msg.type === 'closed') {
              updateSerialUI(false, 'disconnected'); stopTtyStream();
            } else if (msg.type === 'error') {
              appendHyperTerm(`[ERR] ${msg.message}`);
            }
          } catch { /* ignore */ }
        }
        read();
      }).catch(() => {});
    }
    read();
  }).catch(() => {});
}

export function stopTtyStream() {
  if (_ttyStreamCtrl) { _ttyStreamCtrl.abort(); _ttyStreamCtrl = null; }
}

export function isTtyStreamActive() { return _ttyStreamCtrl !== null; }

export async function refreshSerialStatus() {
  try {
    const data = await api('/api/serial/status');
    const t = data.terminal || {};
    const ttys = data.ttys || data.ports || t.ports || [];
    const portSel = $('serialPort');
    if (portSel) {
      const cur = portSel.value || t.selectedPort || data.session || '';
      portSel.innerHTML = ttys.map(p => {
        const val = p.path || p.portName || p.PortName || p.name || String(p);
        const label = p.manufacturer ? `${val}  (${p.manufacturer})` : (p.displayName || p.DisplayName || p.usbProduct || val);
        return `<option value="${esc(val)}">${esc(label)}</option>`;
      }).join('');
      if (!portSel.innerHTML) portSel.innerHTML = '<option value="">-- No ports --</option>';
      if (cur && portSel.querySelector(`option[value="${cur}"]`)) portSel.value = cur;
    }
    const baudSel = $('serialBaud');
    if (baudSel) {
      const cur = baudSel.value || String(t.selectedBaudRate || 115200);
      const rates = t.baudRates || [9600, 19200, 38400, 57600, 115200, 230400, 921600];
      if (!baudSel.options.length || (t.baudRates && baudSel.options.length !== rates.length))
        baudSel.innerHTML = rates.map(b => `<option value="${b}">${b}</option>`).join('');
      baudSel.value = t.selectedBaudRate ? String(t.selectedBaudRate) : cur;
    }
    const connected = !!(data.open || data.connected || t.isConnected);
    const statusTxt = t.connectionStatus || (connected ? `connected (${data.session || ''})` : ' disconnected');
    updateSerialUI(connected, statusTxt);
    const out = $('serialOutput');
    if (out && t.terminalOutput !== undefined) { out.textContent = t.terminalOutput || 'No terminal output.'; out.scrollTop = out.scrollHeight; }
  } catch { updateSerialUI(false, 'offline'); }
}

export async function toggleSerial(connect) {
  if (connect === false || state.serialConnected) {
    stopTtyStream();
    try { await api('/api/serial/disconnect', { method: 'POST', body: '{}' }); toast('Serial disconnected', 'ok'); }
    catch (err) { toast(`Disconnect failed: ${err.message}`, 'bad'); }
  } else {
    const port = $('serialPort')?.value, baud = Number($('serialBaud')?.value) || 115200;
    if (!port) { toast('Select a port first', 'warn'); return; }
    try {
      const res = await api('/api/serial/connect', { method: 'POST', body: JSON.stringify({ port, baudRate: baud, path: port }) });
      if (!res?.terminal) startTtyStream(res?.session || res?.sessionId || port);
      toast(`Connected: ${port} @ ${baud} bps`, 'ok');
    } catch (err) { toast(`Serial error: ${err.message}`, 'bad'); }
  }
  await refreshSerialStatus();
}

export async function sendSerial() {
  const inp = $('serialInput'); if (!inp?.value.trim()) return;
  const text = inp.value + '\r\n';
  try { await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ text }) }); appendHyperTerm(`> ${inp.value}`); inp.value = ''; }
  catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}
