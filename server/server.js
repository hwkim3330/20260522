'use strict';

// Windows: add Npcap to PATH so cap.node can find wpcap.dll
if (process.platform === 'win32') {
  const npcapDir = 'C:\\Windows\\System32\\Npcap';
  if (!process.env.PATH.includes(npcapDir)) {
    process.env.PATH = npcapDir + ';' + process.env.PATH;
  }
}

process.on('uncaughtException',  (err)    => console.error('[FATAL uncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const serialBridge   = require('./services/serialBridge');
const switchProtocol = require('./services/switchProtocol');
const packetBackend  = require('./services/packetBackend');
const nativeWorker   = require('./services/nativeWorker');
const autoEngine     = require('./services/autoEngine');

const app  = express();
const PORT = Number(process.env.PORT || 8080);

app.use(cors());
app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── storage dirs ──────────────────────────────────────────────────────────────
const logsDir    = path.join(__dirname, 'logs');
const testsDir   = path.join(logsDir, 'tests');
const macrosDir  = path.join(logsDir, 'macros');
const reportsDir = path.join(__dirname, 'reports');
[logsDir, testsDir, macrosDir, reportsDir].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const services = { packetBackend, serialBridge, switchProtocol };

app.locals.testsDir       = testsDir;
app.locals.macrosDir      = macrosDir;
app.locals.reportsDir     = reportsDir;
app.locals.serialBridge   = serialBridge;
app.locals.switchProtocol = switchProtocol;
app.locals.packetBackend  = packetBackend;
app.locals.autoEngine     = autoEngine;

autoEngine.init(services, testsDir);

// All commands go through nativeWorker (no C# worker)
async function localCmd(command, payload = {}, _timeoutMs) {
  return nativeWorker.dispatch(command, payload, services);
}
app.locals.localCmd = localCmd;

// ── WebSocket server — browser event relay (serial rx, capture stream) ────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.locals.broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  wss.clients.forEach(ws => { try { ws.send(raw); } catch {} });
};

// Relay native serial events to browser
serialBridge.events.on('serial', (payload) => {
  app.locals.broadcast({ type: 'workerEvent', payload });
});

// ── simple built-in routes ────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ ok: true, version: '2.0.0' }));

app.get('/api/local-addresses', (_req, res) => {
  const nics  = os.networkInterfaces();
  const addrs = [];
  for (const [name, entries] of Object.entries(nics || {})) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal)
        addrs.push({ name, address: e.address, netmask: e.netmask });
    }
  }
  const primary = addrs.find(a => /^172\./.test(a.address))
    || addrs.find(a => /^10\./.test(a.address))
    || addrs.find(a => /^192\.168\./.test(a.address)
         && !/(virtualbox|vmware|hyper)/i.test(a.name))
    || addrs.find(a => !/^169\.254\./.test(a.address))
    || addrs[0];
  res.json({ ok: true, addresses: addrs, primary: primary?.address || 'localhost' });
});

app.get('/api/examples', (_req, res) => {
  res.json({
    ok: true,
    profiles: {
      udp:  { protocol: 'udp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', srcPort: 12345, dstPort: 50000, count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI' } },
      icmp: { protocol: 'icmp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI ping' } },
      arp:  { protocol: 'arp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0 },
    },
    items: [],
  });
});

app.post('/api/simple-bidir-forward-test', async (req, res) => {
  const {
    nodeAUrl, nodeBUrl, nodeAPrimaryInterface, nodeBPrimaryInterface,
    nodeAMonitorInterfaces = [], nodeBMonitorInterfaces = [],
    count = 10, intervalMs = 100, udpSrcPort = 40000, udpDstPort = 50000,
    payloadMarkerPrefix = 'KETI_SIMPLE_FORWARD', captureTimeoutMs = 3000,
    direction = 'A_TO_B',
  } = req.body || {};

  const directions = direction === 'BOTH' ? ['A_TO_B', 'B_TO_A'] : [direction];
  const results    = [];

  for (const dir of directions) {
    const senderUrl   = dir === 'A_TO_B' ? nodeAUrl   : nodeBUrl;
    const receiverUrl = dir === 'A_TO_B' ? nodeBUrl   : nodeAUrl;
    const senderIface = dir === 'A_TO_B' ? nodeAPrimaryInterface : nodeBPrimaryInterface;
    const recvIface   = dir === 'A_TO_B' ? nodeBPrimaryInterface : nodeAPrimaryInterface;
    const to          = (ms) => ({ signal: AbortSignal.timeout(ms) });
    const hdr         = { 'Content-Type': 'application/json' };

    try {
      await fetch(`${receiverUrl}/api/capture/clear`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) }).catch(() => {});
      await fetch(`${receiverUrl}/api/capture/start`, { method: 'POST', headers: hdr, body: JSON.stringify({ interfaces: [recvIface] }), ...to(15000) }).catch(() => {});

      const marker   = `${payloadMarkerPrefix}_${dir}_${Date.now()}`;
      const sendBody = { interface: senderIface, protocol: 'udp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '169.254.1.1', dstIp: '169.254.1.2', srcPort: udpSrcPort, dstPort: udpDstPort, count, intervalMs, payload: { mode: 'text', data: marker } };
      await fetch(`${senderUrl}/api/send`, { method: 'POST', headers: hdr, body: JSON.stringify(sendBody), ...to(30000) }).catch(() => {});

      await new Promise(r => setTimeout(r, Math.min(captureTimeoutMs, 10000)));

      await fetch(`${receiverUrl}/api/capture/stop`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) }).catch(() => {});
      const capResp = await fetch(`${receiverUrl}/api/capture/packets?limit=1000`, to(10000)).catch(() => null);
      const capData = capResp ? await capResp.json().catch(() => ({})) : {};
      const rows    = capData.rows ?? [];
      const matched = rows.filter(r => JSON.stringify(r.decoded || {}).includes(marker));

      results.push({ direction: dir, result: matched.length >= count ? 'PASS' : 'FAIL', senderUrl, receiverUrl, sent: count, matched: matched.length });
    } catch (e) {
      results.push({ direction: dir, result: 'FAIL', error: e.message, senderUrl, receiverUrl });
    }
  }

  const overall = results.every(r => r.result === 'PASS') ? 'PASS' : 'FAIL';
  res.json({ ok: true, overall, directions: results });
});

// ── routes ────────────────────────────────────────────────────────────────────
app.use('/api/remote-capture', require('./routes/remoteCapture'));
app.use('/api', require('./routes/health'));
app.use('/api', require('./routes/packet'));
app.use('/api', require('./routes/capture'));
app.use('/api', require('./routes/tty'));
app.use('/api', require('./routes/testcases'));
app.use('/api', require('./routes/packetFlow'));
app.use('/api', require('./routes/macro'));
app.use('/api', require('./routes/logs'));
app.use('/api', require('./routes/tests'));
app.use('/api', require('./routes/scenario'));
app.use('/api', require('./routes/register'));
app.use('/api', require('./routes/fdb'));
app.use('/api', require('./routes/mdio'));
app.use('/api', require('./routes/counter'));
app.use('/api', require('./routes/timestamp'));
app.use('/api', require('./routes/auto'));

app.use('/reports', express.static(reportsDir));
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// ── start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nics   = os.networkInterfaces();
  const wifiIp = [
    Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^172\./.test(e.address)),
    Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^10\./.test(e.address)),
    Object.values(nics).flat().find(e => e?.family === 'IPv4' && !e.internal && /^192\.168\./.test(e.address)),
  ].find(Boolean)?.address;

  const platform = process.platform === 'win32' ? 'Windows (Npcap)' : `Linux (libpcap/tcpdump)`;
  const capSt    = packetBackend.isAvailable()
    ? 'cap npm  ready  (send + capture)'
    : packetBackend.isTcpdumpAvailable?.()
      ? 'tcpdump fallback  (capture only — install libpcap-dev + npm install cap  for full support)'
      : 'NO packet backend  (Windows: install Npcap + run  npm install cap)';
  const serSt    = serialBridge.isAvailable()
    ? 'serialport npm ready'
    : process.platform === 'linux'
      ? 'Linux TTY ready (stty fallback)'
      : 'no serial  (npm install serialport)';

  console.log(`\n[PacketLabManager] ──────────────────────────────────`);
  console.log(`[PacketLabManager] Local    : http://localhost:${PORT}`);
  if (wifiIp) console.log(`[PacketLabManager] Network  : http://${wifiIp}:${PORT}`);
  console.log(`[PacketLabManager] Platform : ${platform}`);
  console.log(`[PacketLabManager] Packets  : ${capSt}`);
  console.log(`[PacketLabManager] Serial   : ${serSt}`);
  console.log(`[PacketLabManager] ──────────────────────────────────\n`);
});
