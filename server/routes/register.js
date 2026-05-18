'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

function hasWorker(req) {
  const { workerHub, localWorkerId } = req.app.locals;
  return workerHub.hasWorker(localWorkerId);
}

// GET /api/register/status
router.get('/register/status', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('registerstatus', {}, 5000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.registerStatus();
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/register/read   body: { offset|address }
router.post('/register/read', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('registerread', req.body || {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.registerRead(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/register/write  body: { offset|address, value }
router.post('/register/write', async (req, res) => {
  try {
    if (hasWorker(req)) {
      return res.json({ ok: true, ...(await req.app.locals.localCmd('registerwrite', req.body || {}, 15000) || {}) });
    }
    const r = await req.app.locals.switchProtocol.registerWrite(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
