'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();

// GET /api/logs  - return recent test + macro logs
router.get('/logs', (req, res) => {
  try {
    const testsDir  = req.app.locals.testsDir;
    const macrosDir = req.app.locals.macrosDir;
    const limit     = parseInt(req.query.limit ?? '50');

    // Persistent state files stored in the same dir — exclude them from run logs
    const STATE_FILES = new Set(['test-cases.json', 'sequence.json', '__run_sequence__.json', 'portmap.json']);

    const readDir = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json') && !STATE_FILES.has(f))
        .sort().reverse()
        .slice(0, limit)
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
          catch { return { file: f, error: 'parse error' }; }
        });
    };

    res.json({
      ok:     true,
      tests:  readDir(testsDir),
      macros: readDir(macrosDir)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
