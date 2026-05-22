'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, err) { res.status(503).json({ ok: false, error: err.message }); }

function buildBpfFilter({ srcMac, dstMac, etherType, bpfFilter } = {}) {
  if (bpfFilter && bpfFilter.trim()) return bpfFilter.trim();
  const parts = [];
  if (srcMac    && srcMac.trim())    parts.push(`ether src ${srcMac.trim().toLowerCase()}`);
  if (dstMac    && dstMac.trim())    parts.push(`ether dst ${dstMac.trim().toLowerCase()}`);
  if (etherType && etherType.trim()) parts.push(`ether proto ${etherType.trim()}`);
  return parts.join(' and ');
}

// GET /api/capture/status
router.get('/capture/status', async (req, res) => {
  try {
    const pb    = req.app.locals.packetBackend;
    const st    = pb.getCaptureStatus();
    const ifaces = pb.listInterfaces().map(i => ({
      name: i.name, description: i.description, state: i.state, mac: i.mac,
      selected: st.captureInterfaces.includes(i.name),
    }));
    res.json({ ok: true, running: st.capturing, capturing: st.capturing,
               totalPackets: st.captureCount, captureCount: st.captureCount, interfaces: ifaces });
  } catch (err) { wErr(res, err); }
});

// GET /api/capture/packets?limit=500&offset=0
router.get('/capture/packets', async (req, res) => {
  try {
    const limit  = Number(req.query.limit  ?? 1000);
    const offset = Number(req.query.offset ?? 0);
    const { rows, total } = req.app.locals.packetBackend.getCaptures(limit, offset);
    res.json({ ok: true, rows, total });
  } catch (err) { wErr(res, err); }
});

// POST /api/capture/start
router.post('/capture/start', async (req, res) => {
  try {
    const body      = req.body || {};
    const bpfFilter = buildBpfFilter(body);
    const pb        = req.app.locals.packetBackend;
    const ifaces    = body.interfaces || [];

    pb.clearCapture();
    let captureErr = '';
    pb.startCapture(ifaces, bpfFilter, () => {}, (e) => { captureErr = e.message; });

    // Brief wait so tcpdump/cap can fail fast (permission denied, no device)
    await new Promise(r => setTimeout(r, 350));

    const running = pb.isCapturing();
    const lastErr = pb.getLastCaptureError?.() || captureErr;
    const realErr = lastErr && !/listening on /i.test(lastErr) ? lastErr : '';

    if (!running && realErr) {
      const hint = /permission/i.test(realErr)
        ? ' → fix: run as Administrator (Windows) or sudo (Linux)'
        : /no such device|siocgifhwaddr/i.test(realErr)
          ? ' → interface not found; check /api/interfaces'
          : '';
      return res.status(500).json({ ok: false, error: realErr + hint });
    }
    res.json({ ok: true, bpfFilter, capturing: running,
               interfaces: pb.getCaptureDeviceNames().length,
               warning: !running ? 'No matching capture device found' : undefined });
  } catch (err) { wErr(res, err); }
});

// POST /api/capture/stop
router.post('/capture/stop', async (req, res) => {
  try {
    req.app.locals.packetBackend.stopCapture();
    res.json({ ok: true, capturing: false });
  } catch (err) { wErr(res, err); }
});

// POST /api/capture/clear
router.post('/capture/clear', async (req, res) => {
  try {
    req.app.locals.packetBackend.clearCapture();
    res.json({ ok: true });
  } catch (err) { wErr(res, err); }
});

// POST /api/capture  (one-shot: start → wait → stop → return)
router.post('/capture', async (req, res) => {
  const { interfaces = [], timeoutMs = 5000, limit = 500 } = req.body || {};
  try {
    const pb = req.app.locals.packetBackend;
    pb.clearCapture();
    pb.startCapture(interfaces, '', () => {}, () => {});
    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 30000)));
    pb.stopCapture();
    const { rows, total } = pb.getCaptures(limit, 0);
    res.json({ ok: true, rows, total });
  } catch (err) { wErr(res, err); }
});

// POST /api/capture-stream — NDJSON streaming via cap/tcpdump
router.post('/capture-stream', async (req, res) => {
  const { packetBackend } = req.app.locals;
  const {
    interfaces: ifaceArr, interface: ifaceSingle,
    timeoutMs, timeoutSec, srcMac = '', dstMac = '', etherType = '',
  } = req.body || {};

  const interfaces = ifaceArr?.length ? ifaceArr : ifaceSingle ? [ifaceSingle] : [];
  let timeout = timeoutMs !== undefined ? timeoutMs
    : timeoutSec !== undefined          ? timeoutSec * 1000
    : 3600000;
  if (timeout === 0) timeout = 3600000;
  timeout = Math.min(timeout, 3600000);

  const normMac = (m) => (m || '').replace(/[:\-]/g, '').toLowerCase();
  const fSrc    = srcMac    ? normMac(srcMac)   : '';
  const fDst    = dstMac    ? normMac(dstMac)   : '';
  const fEtype  = etherType ? etherType.toLowerCase().replace('0x', '') : '';

  function passes(rec) {
    if (!fSrc && !fDst && !fEtype) return true;
    const eth = rec.decoded?.ethernet || rec.decoded?.eth || {};
    if (fSrc   && normMac(eth.srcMac   || '') !== fSrc)   return false;
    if (fDst   && normMac(eth.dstMac   || '') !== fDst)   return false;
    if (fEtype && (eth.etherType || '').replace('0x', '').toLowerCase() !== fEtype) return false;
    return true;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write   = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };
  let   stopped = false;
  const bpf     = buildBpfFilter({ srcMac, dstMac, etherType });

  const onRecord = (rec) => { if (!stopped && passes(rec)) write({ type: 'frame', ...rec }); };
  packetBackend.addStreamCallback(onRecord);
  packetBackend.clearCapture();
  const ok = packetBackend.startCapture(interfaces, bpf, () => {}, (e) => write({ error: e.message }));
  if (!ok) {
    packetBackend.removeStreamCallback(onRecord);
    write({ error: 'No capture device available. Windows: install Npcap + cap npm. Linux: install libpcap-dev + cap npm or tcpdump.' });
    res.end();
    return;
  }

  const stop = () => {
    if (stopped) return; stopped = true;
    packetBackend.removeStreamCallback(onRecord);
    packetBackend.stopCapture();
    write({ done: true }); res.end();
  };
  const timer = setTimeout(stop, timeout);
  req.on('close', () => { clearTimeout(timer); stop(); });
});

module.exports = router;
