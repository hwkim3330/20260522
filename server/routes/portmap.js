'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();

function getConfigPath(req) {
  return path.join(req.app.locals.logsDir || path.join(__dirname, '../logs'), 'portmap.json');
}

const DEFAULT_MAP = {
  ports: [
    { portId: 0, nic: '', description: '' },
    { portId: 1, nic: '', description: '' },
    { portId: 2, nic: '', description: '' },
    { portId: 3, nic: '', description: '' },
    { portId: 4, nic: '', description: '' },
    { portId: 5, nic: '', description: '' },
    { portId: 6, nic: '', description: '' },
    { portId: 7, nic: '', description: '' },
  ]
};

// GET /api/portmap
router.get('/portmap', (req, res) => {
  try {
    const fp = getConfigPath(req);
    if (!fs.existsSync(fp)) return res.json({ ok: true, ...DEFAULT_MAP });
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.json({ ok: true, ports: data.ports || DEFAULT_MAP.ports });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/portmap
router.post('/portmap', (req, res) => {
  try {
    const { ports } = req.body;
    if (!Array.isArray(ports)) return res.status(400).json({ ok: false, error: 'ports array required' });
    const fp = getConfigPath(req);
    fs.writeFileSync(fp, JSON.stringify({ ports }, null, 2));
    res.json({ ok: true, saved: true, ports });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/portmap/resolve/:portId  →  returns the NIC name for a port
router.get('/portmap/resolve/:portId', (req, res) => {
  try {
    const portId = parseInt(req.params.portId, 10);
    const fp = getConfigPath(req);
    const data = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : DEFAULT_MAP;
    const entry = (data.ports || []).find(p => p.portId === portId);
    if (!entry) return res.status(404).json({ ok: false, error: `Port ${portId} not in map` });
    res.json({ ok: true, portId, nic: entry.nic || '', description: entry.description || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
