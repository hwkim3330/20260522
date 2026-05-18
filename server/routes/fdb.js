'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

function hasWorker(req) {
  const { workerHub, localWorkerId } = req.app.locals;
  return workerHub.hasWorker(localWorkerId);
}

// POST /api/fdb/read   body: { mac, vlanId? }
router.post('/fdb/read', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('fdbread', req.body || {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.fdbRead(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/write  body: { mac, port, vlanId?, static? }
router.post('/fdb/write', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('fdbwrite', req.body || {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.fdbWrite(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/delete body: { mac, vlanId? }
router.post('/fdb/delete', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('fdbdelete', req.body || {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.fdbDelete(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/flush
router.post('/fdb/flush', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('fdbflush', {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.fdbFlush(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
