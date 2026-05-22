'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, err) {
  res.status(503).json({ ok: false, error: err.message });
}

// GET /api/interfaces
router.get('/interfaces', async (req, res) => {
  try {
    const interfaces = req.app.locals.packetBackend.listInterfaces();
    res.json({ ok: true, interfaces, stdout: { interfaces } });
  } catch (err) { wErr(res, err); }
});

// POST /api/build
router.post('/build', async (req, res) => {
  try {
    const { buildFrame, normalizeProfile } = require('../services/frameBuilder');
    const { decodeFrame } = require('../services/packetBackend');
    const frame   = buildFrame(normalizeProfile(req.body || {}));
    const decoded = decodeFrame(frame);
    const data    = { frameHex: frame.toString('hex'), frameLength: frame.length, decoded };
    res.json({ ok: true, ...data, stdout: data });
  } catch (err) { wErr(res, err); }
});

// POST /api/send
router.post('/send', async (req, res) => {
  try {
    const result = await req.app.locals.packetBackend.sendPackets(req.body || {});
    res.json({ ok: true, ...result, stdout: result });
  } catch (err) { wErr(res, err); }
});

// POST /api/packet/send (alias)
router.post('/packet/send', async (req, res) => {
  try {
    const result = await req.app.locals.packetBackend.sendPackets(req.body || {});
    res.json({ ok: true, ...result, stdout: result });
  } catch (err) { wErr(res, err); }
});

// POST /api/probe-node  — server-side proxy to avoid browser CORS
router.post('/probe-node', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const base = url.replace(/\/$/, '');
    const resp = await fetch(`${base}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    const ifaces = (data.interfaces ?? []).map(i => ({
      key: i.key || i.name || '', name: i.name || i.key || '',
      mac: i.mac || '', state: i.state || 'unknown', ipv4: i.ipv4 || [],
      description: i.description || '',
    }));
    res.json({ ok: true, url: base, interfaces: ifaces });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

// GET /api/arp-lookup?ip=...
router.get('/arp-lookup', async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.json({ ok: false, error: 'ip required' });
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const { stdout } = await promisify(execFile)('arp', ['-a', ip]);
    const match = stdout.match(/([0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2})/i);
    if (match) return res.json({ ok: true, mac: match[1].replace(/-/g, ':').toLowerCase(), ip });
    res.json({ ok: false, error: 'not in ARP table', ip });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// GET /api/worker/status — kept for UI compatibility, reports native backend
router.get('/worker/status', async (req, res) => {
  try {
    const st = req.app.locals.packetBackend.getCaptureStatus();
    res.json({ ok: true, mode: 'native', workerId: 'native', capturing: st.capturing, captureCount: st.captureCount, captureInterfaces: st.captureInterfaces });
  } catch (err) { wErr(res, err); }
});

module.exports = router;
