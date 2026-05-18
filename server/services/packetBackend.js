'use strict';
/**
 * packetBackend.js — Native packet send/capture using `cap` npm (libpcap).
 * Used as fallback when C# worker is not connected (Linux / headless).
 * Requires: npm install cap  +  apt install libpcap-dev (Linux) / Npcap (Windows)
 */

const os   = require('os');
const { buildFrame } = require('./frameBuilder');

let Cap;
try { Cap = require('cap').Cap; } catch {}

// ── Device resolution ──────────────────────────────────────────────────────────

function getDeviceList() {
  if (!Cap) return [];
  try { return Cap.deviceList() || []; } catch { return []; }
}

/** Resolve OS NIC name (e.g. "Wi-Fi", "eth0") to pcap device name. */
function resolveDevice(ifaceName) {
  if (!Cap) return null;
  if (!ifaceName) {
    const devs = getDeviceList();
    return devs.length ? devs[0].name : null;
  }

  const nics  = os.networkInterfaces();
  const devs  = getDeviceList();

  // Direct name match (Linux: eth0, wlan0)
  const direct = devs.find(d => d.name === ifaceName);
  if (direct) return direct.name;

  // Match by OS NIC IPv4 address
  const nicIps = new Set();
  for (const [name, entries] of Object.entries(nics || {})) {
    if (name.toLowerCase() === ifaceName.toLowerCase()) {
      for (const e of entries || []) if (e.family === 'IPv4') nicIps.add(e.address);
    }
  }
  for (const d of devs) {
    for (const a of d.addresses || []) {
      if (nicIps.has(a.addr)) return d.name;
    }
  }

  // Partial name / description match
  const lower = ifaceName.toLowerCase();
  const partial = devs.find(d =>
    d.name.toLowerCase().includes(lower) ||
    (d.description || '').toLowerCase().includes(lower));
  return partial?.name ?? null;
}

// ── Active captures ────────────────────────────────────────────────────────────

const activeCaptures = new Map(); // iface → { cap, buffer }

function startCapture(ifaceNames, filter, onPacket, onError) {
  if (!Cap) return false;

  const ifaces = ifaceNames.length ? ifaceNames : [null];
  let started  = 0;

  for (const name of ifaces) {
    const dev = resolveDevice(name);
    if (!dev) continue;
    if (activeCaptures.has(dev)) continue;

    try {
      const c      = new Cap();
      const buf    = Buffer.alloc(65535);
      c.open(dev, filter || '', 10 * 1024 * 1024, buf);
      c.setMinBytes && c.setMinBytes(0);

      c.on('packet', (nbytes) => {
        try {
          const frame = Buffer.from(buf.slice(0, nbytes));
          const no      = ++captureSeq;
          const ts      = Date.now() / 1000;
          const decoded = decodeFrame(frame);
          const record  = { no, timestamp: ts, interface: dev, length: nbytes, frameHex: frame.toString('hex'), decoded };
          captureRows.push(record);
          onPacket(dev, frame, record);
          for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
        } catch {}
      });
      c.on('error', (err) => { try { onError && onError(err); } catch {} });

      activeCaptures.set(dev, { cap: c, buffer: buf });
      started++;
    } catch (e) { /* device not available */ }
  }
  return started > 0;
}

function stopCapture() {
  for (const [, { cap }] of activeCaptures) {
    try { cap.close(); } catch {}
  }
  activeCaptures.clear();
}

function isCapturing() { return activeCaptures.size > 0; }

function getCaptureDeviceNames() {
  return Array.from(activeCaptures.keys());
}

// ── Send ───────────────────────────────────────────────────────────────────────

async function sendPackets(profile) {
  if (!Cap) throw new Error('cap npm not installed (run: npm install cap)');

  const dev = resolveDevice(profile.interface);
  if (!dev) throw new Error(`Interface not found: ${profile.interface}`);

  const count      = profile.count      ?? 1;
  const intervalMs = profile.intervalMs ?? 0;

  // Auto-fill srcMac if missing (look up from OS NIC)
  if (!profile.srcMac) {
    const nics = os.networkInterfaces();
    const iface = (profile.interface || '').toLowerCase();
    for (const [name, entries] of Object.entries(nics || {})) {
      if (name.toLowerCase() === iface) {
        const e4 = (entries || []).find(e => e.family === 'IPv4');
        if (e4 && e4.mac && e4.mac !== '00:00:00:00:00:00') {
          profile = { ...profile, srcMac: e4.mac };
          break;
        }
      }
    }
  }

  const c   = new Cap();
  const buf = Buffer.alloc(65535);
  try {
    c.open(dev, '', 0, buf);
    let sent  = 0;
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      const frame = buildFrame(profile, i);
      c.send(frame, frame.length);
      sent++;
      bytes += frame.length;
      if (intervalMs > 0 && i < count - 1)
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { framesSent: sent, bytesSent: bytes };
  } finally {
    try { c.close(); } catch {}
  }
}

function isAvailable() { return !!Cap; }

// ── Frame decoder ──────────────────────────────────────────────────────────────

function macStr(buf, off) {
  return Array.from(buf.slice(off, off + 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
}

function decodeFrame(buf) {
  const result = { length: buf.length };
  if (buf.length < 14) return result;

  const dstMac    = macStr(buf, 0);
  const srcMac    = macStr(buf, 6);
  let   etherType = buf.readUInt16BE(12);
  let   offset    = 14;

  result.ethernet = { dstMac, srcMac, etherType: '0x' + etherType.toString(16).padStart(4, '0') };

  if (etherType === 0x8100 && buf.length >= 18) {
    const tci = buf.readUInt16BE(14);
    result.ethernet.vlan = { priority: (tci >> 13) & 7, dei: !!(tci & 0x1000), id: tci & 0xFFF };
    etherType = buf.readUInt16BE(16);
    result.ethernet.etherType = '0x' + etherType.toString(16).padStart(4, '0');
    offset = 18;
  }

  if (etherType === 0x0800 && buf.length >= offset + 20) {
    const ihl   = (buf[offset] & 0x0F) * 4;
    const proto = buf[offset + 9];
    const src   = Array.from(buf.slice(offset + 12, offset + 16)).join('.');
    const dst   = Array.from(buf.slice(offset + 16, offset + 20)).join('.');
    result.ipv4 = { src, dst, ttl: buf[offset + 8], protocol: proto, totalLength: buf.readUInt16BE(offset + 2) };

    const l4 = offset + ihl;
    if (proto === 17 && buf.length >= l4 + 8) {
      result.udp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), length: buf.readUInt16BE(l4 + 4) };
      if (buf.length > l4 + 8) {
        const p = buf.slice(l4 + 8);
        result.payload = { hex: p.toString('hex'), text: p.toString('utf8').replace(/[^\x20-\x7E]/g, '.') };
      }
    } else if (proto === 6 && buf.length >= l4 + 20) {
      result.tcp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), flags: buf[l4 + 13] };
    } else if (proto === 1 && buf.length >= l4 + 4) {
      result.icmp = { type: buf[l4], code: buf[l4 + 1] };
    }
  } else if (etherType === 0x0806 && buf.length >= offset + 28) {
    result.arp = {
      op:        buf.readUInt16BE(offset + 6) === 1 ? 'request' : 'reply',
      senderMac: macStr(buf, offset + 8),
      senderIp:  Array.from(buf.slice(offset + 14, offset + 18)).join('.'),
      targetMac: macStr(buf, offset + 18),
      targetIp:  Array.from(buf.slice(offset + 24, offset + 28)).join('.'),
    };
  }
  return result;
}

// ── Capture buffer ─────────────────────────────────────────────────────────────

let captureSeq  = 0;
let captureRows = [];
let captureStreamCbs = [];

function clearCapture() { captureSeq = 0; captureRows = []; }

function getCaptures(limit = 1000, offset = 0) {
  const slice = captureRows.slice(offset, offset + limit);
  return { rows: slice, total: captureRows.length };
}

function getCaptureStatus(ifaceNames) {
  return {
    capturing:          activeCaptures.size > 0,
    captureCount:       captureRows.length,
    captureInterfaces:  ifaceNames ?? getCaptureDeviceNames(),
  };
}

// ── Interface list ─────────────────────────────────────────────────────────────

function listInterfaces() {
  const nics   = os.networkInterfaces();
  const devs   = getDeviceList();
  const result = [];

  for (const [name, entries] of Object.entries(nics || {})) {
    const ipv4 = (entries || [])
      .filter(e => e.family === 'IPv4')
      .map(e => ({ local: e.address, prefixlen: prefixFromMask(e.netmask) }));

    const mac = (entries || []).find(e => e.mac && e.mac !== '00:00:00:00:00:00')?.mac ?? '';
    const state = ipv4.length > 0 ? 'up' : 'down';

    result.push({ name, key: name, mac, state, mtu: 1500, ipv4, description: name });
  }
  return result;
}

function prefixFromMask(mask) {
  if (!mask) return 0;
  return mask.split('.').reduce((a, b) => a + (parseInt(b, 10) >>> 0).toString(2).split('1').length - 1, 0);
}

function addStreamCallback(cb)    { captureStreamCbs.push(cb); }
function removeStreamCallback(cb) { captureStreamCbs = captureStreamCbs.filter(x => x !== cb); }

module.exports = {
  sendPackets, startCapture, stopCapture, isCapturing,
  getCaptureDeviceNames, clearCapture, getCaptures, getCaptureStatus,
  addStreamCallback, removeStreamCallback,
  listInterfaces, resolveDevice, isAvailable, decodeFrame,
};
