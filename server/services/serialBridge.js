'use strict';
/**
 * serialBridge.js — Native Node.js serial port manager.
 * Used as fallback when C# worker is not connected (Linux / headless).
 * Exposes same event shape as C# worker: { kind:'serial', rxType:'rx', hex, session }
 */

const { EventEmitter } = require('events');

let SerialPort;
try { ({ SerialPort } = require('serialport')); } catch {}

const events = new EventEmitter();
events.setMaxListeners(200);

// sessions: Map<string, SerialSession>
const sessions = new Map();

class SerialSession {
  constructor(path) {
    this.path      = path;
    this.lineBuffer = '';
    this._cmdQueue  = []; // { resolve, reject, timer }
  }

  open(opts = {}) {
    if (!SerialPort) return Promise.reject(new Error('serialport npm not installed'));
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path:      this.path,
        baudRate:  opts.baudRate  ?? 115200,
        dataBits:  opts.dataBits  ?? 8,
        stopBits:  opts.stopBits  ?? 1,
        parity:    opts.parity    ?? 'none',
        autoOpen:  false,
      });

      this.port.on('data', (chunk) => {
        const hex = chunk.toString('hex');
        events.emit('serial', { kind: 'serial', rxType: 'rx', hex, session: this.path });

        // Accumulate for command responses
        this.lineBuffer += chunk.toString('utf8');
        const parts = this.lineBuffer.split(/\r?\n/);
        this.lineBuffer = parts.pop() ?? '';

        for (const line of parts) {
          const t = line.trim();
          if (!t) continue;
          if (this._cmdQueue.length > 0 && (t.startsWith('OK') || t.startsWith('ERR'))) {
            const { resolve: res, reject: rej, timer } = this._cmdQueue.shift();
            clearTimeout(timer);
            if (t.startsWith('OK')) res(t.slice(2).trim());
            else                    rej(new Error(t.slice(3).trim() || 'ERR'));
          }
        }
      });

      this.port.on('close', () => {
        sessions.delete(this.path);
        events.emit('serial', { kind: 'serial', type: 'closed', session: this.path });
      });

      this.port.on('error', (err) => {
        events.emit('serial', { kind: 'serial', type: 'error', message: err.message, session: this.path });
      });

      this.port.open((err) => { if (err) reject(err); else resolve(); });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.port) { resolve(); return; }
      this.port.close(() => resolve());
    });
  }

  write({ hex, text }) {
    if (!this.port) return Promise.reject(new Error(`Session not open: ${this.path}`));
    const data = hex ? Buffer.from(hex, 'hex') : Buffer.from(text ?? '', 'utf8');
    return new Promise((resolve, reject) => {
      this.port.write(data, (err) => err ? reject(err) : resolve());
    });
  }

  setSignals(signals) {
    if (!this.port) return Promise.resolve();
    return new Promise((resolve) => { this.port.set(signals, () => resolve()); });
  }

  /** Send a text command and wait for OK/ERR response line. */
  command(cmd, timeoutMs = 3000) {
    if (!this.port) return Promise.reject(new Error('Serial port not open'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._cmdQueue.findIndex(q => q.timer === timer);
        if (i >= 0) this._cmdQueue.splice(i, 1);
        reject(new Error('Serial command timeout'));
      }, timeoutMs);

      this._cmdQueue.push({ resolve, reject, timer });
      const line = (cmd.endsWith('\n') ? cmd : cmd + '\r\n');
      this.port.write(Buffer.from(line, 'utf8'), (err) => {
        if (err) {
          const i = this._cmdQueue.findIndex(q => q.timer === timer);
          if (i >= 0) this._cmdQueue.splice(i, 1);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function list() {
  if (!SerialPort) return [];
  const ports = await SerialPort.list();
  return ports.map(p => ({
    path:         p.path,
    name:         p.path,
    manufacturer: p.manufacturer  || '',
    serialNumber: p.serialNumber  || '',
    usbVendorId:  p.vendorId      || '',
    usbProductId: p.productId     || '',
    usbProduct:   p.friendlyName  || p.manufacturer || '',
  }));
}

async function open(path, opts = {}) {
  if (sessions.has(path)) return { sessionId: path, session: path };
  const s = new SerialSession(path);
  await s.open(opts);
  sessions.set(path, s);
  return { sessionId: path, session: path };
}

async function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  await s.close();
  sessions.delete(sessionId);
}

function write(sessionId, data) {
  const s = sessions.get(sessionId) ?? sessions.values().next().value;
  if (!s) throw new Error('Serial port not open');
  return s.write(data);
}

function setSignals(sessionId, signals) {
  const s = sessions.get(sessionId) ?? sessions.values().next().value;
  if (!s) return Promise.resolve();
  return s.setSignals(signals);
}

function command(sessionId, cmd, timeoutMs) {
  const s = sessions.get(sessionId) ?? sessions.values().next().value;
  if (!s) return Promise.reject(new Error('Serial port not open'));
  return s.command(cmd, timeoutMs);
}

function getStatus() {
  const open = Array.from(sessions.keys());
  return { sessions: open, open: open.length > 0, session: open[0] ?? null };
}

function getSession(preferredId) {
  if (preferredId && sessions.has(preferredId)) return preferredId;
  return sessions.keys().next().value ?? null;
}

function isAvailable() { return !!SerialPort; }

module.exports = { list, open, close, write, setSignals, command, getStatus, getSession, isAvailable, events };
