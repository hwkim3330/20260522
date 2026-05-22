'use strict';
const { Router } = require('express');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const router = Router();

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// ── Sequence file helpers ─────────────────────────────────────────────────────
function seqFile(req)       { return path.join(req.app.locals.testsDir, 'sequence.json'); }
function seqLoad(req)       { const f = seqFile(req); if (!fs.existsSync(f)) return []; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } }
function seqSave(req, items){ fs.writeFileSync(seqFile(req), JSON.stringify(items, null, 2)); }

// ── Testcase file helpers ─────────────────────────────────────────────────────
function tcFile(req)      { return path.join(req.app.locals.testsDir, 'test-cases.json'); }
function tcLoad(req)      { const f = tcFile(req); if (!fs.existsSync(f)) return [{ id: 'default', name: 'Default Group', cases: [] }]; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } }
function tcSave(req, data){ fs.writeFileSync(tcFile(req), JSON.stringify(data, null, 2)); }

// ── Legacy /api/scenarios/* aliases ──────────────────────────────────────────
router.post('/scenarios/run', async (req, res) => {
  try {
    const test = req.body?.test;
    if (!test) return res.status(400).json({ ok: false, error: 'test required' });
    req.app.locals.autoEngine.runTest(test).catch(() => {});
    res.json({ ok: true, test, status: 'started' });
  } catch (e) { wErr(res, e); }
});
router.get('/scenarios/status', (req, res) => {
  try { res.json({ ok: true, ...req.app.locals.autoEngine.getStatus() }); } catch (e) { wErr(res, e); }
});
router.get('/scenarios/results', (req, res) => {
  try { res.json({ ok: true, rows: req.app.locals.autoEngine.getResults() }); } catch (e) { wErr(res, e); }
});

// ── CSV helpers ───────────────────────────────────────────────────────────────
const scenariosDir = path.join(__dirname, '..', 'testScenarios');

function parseCsvRows(text) {
  const lines   = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/�+$/, ''));
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row  = {};
    headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v));
}

function scanCsvFiles(dir, base) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    if (fs.statSync(full).isDirectory()) result.push(...scanCsvFiles(full, rel));
    else if (entry.endsWith('.csv'))      result.push(rel);
  }
  return result;
}

function buildCsvTree(dir, base) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    if (fs.statSync(full).isDirectory())
      result.push({ type: 'dir', name: entry, path: rel, children: buildCsvTree(full, rel) });
    else if (entry.endsWith('.csv'))
      result.push({ type: 'file', name: entry, path: rel, isPacket: entry.toLowerCase().includes('packet') });
  }
  return result;
}

function buildGroupsFromCsvs(all) {
  const tcCsvs        = all.filter(f => !path.basename(f).toLowerCase().includes('packet'));
  const rootPacketCsv = all.find(f => !f.includes('/') && path.basename(f).toLowerCase().includes('packet'));
  const byFolder      = new Map();
  for (const relPath of tcCsvs) {
    const folder = relPath.includes('/') ? relPath.split('/')[0] : '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(relPath);
  }
  const groups = [];
  for (const [folder, paths] of byFolder) {
    if (folder === '(root)') continue;
    const cases = paths.sort().map(relPath => {
      const text      = fs.readFileSync(path.join(scenariosDir, relPath), 'utf8');
      const rows      = parseCsvRows(text);
      rows.sort((a, b) => {
        const tidA = parseInt(a['TC_ID'] || a['TC_Id'] || '0');
        const tidB = parseInt(b['TC_ID'] || b['TC_Id'] || '0');
        const sidA = parseInt(a['Test_Scenario_ID'] || '0');
        const sidB = parseInt(b['Test_Scenario_ID'] || '0');
        return (tidA - tidB) || (sidA - sidB);
      });
      const first = rows[0] || {};
      return {
        id: crypto.randomUUID(),
        name: path.basename(relPath, '.csv'),
        path: relPath, packetCsv: rootPacketCsv || null,
        testScenarioId: parseInt(first['Test_Scenario_ID'] || '0'),
        tcId: parseInt(first['TC_ID'] || first['TC_Id'] || '0'),
        steps: rows,
      };
    }).sort((a, b) => (a.testScenarioId - b.testScenarioId) || (a.tcId - b.tcId) || a.name.localeCompare(b.name));
    if (cases.length) groups.push({ id: crypto.randomUUID(), name: folder, cases });
  }
  groups.sort((a, b) => {
    const minA = Math.min(...a.cases.map(c => c.testScenarioId));
    const minB = Math.min(...b.cases.map(c => c.testScenarioId));
    return (minA - minB) || a.name.localeCompare(b.name);
  });
  return groups;
}

// ── CSV scenario routes ───────────────────────────────────────────────────────
router.get('/testcases/csv-tree',      (req, res) => { try { res.json({ ok: true, tree: buildCsvTree(scenariosDir, '') }); } catch (e) { wErr(res, e); } });
router.get('/testcases/scan-scenarios',(req, res) => { try { res.json({ ok: true, files: scanCsvFiles(scenariosDir, '').filter(f => !path.basename(f).toLowerCase().includes('packet')) }); } catch (e) { wErr(res, e); } });

router.post('/testcases/import-all-csv', (req, res) => {
  try {
    const groups  = buildGroupsFromCsvs(scanCsvFiles(scenariosDir, ''));
    tcSave(req, groups);
    res.json({ ok: true, imported: groups.reduce((s, g) => s + g.cases.length, 0) });
  } catch (e) { wErr(res, e); }
});

router.get('/testcases/csv-content', (req, res) => {
  try {
    const relPath = req.query.path || '';
    const full    = path.resolve(scenariosDir, relPath);
    if (!full.startsWith(scenariosDir)) return res.status(400).json({ ok: false, error: 'Invalid path' });
    const rows = parseCsvRows(fs.readFileSync(full, 'utf8'));
    res.json({ ok: true, rows, headers: rows.length ? Object.keys(rows[0]) : [] });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/upload', (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (!name || !content) return res.status(400).json({ ok: false, error: 'name and content required' });
    fs.writeFileSync(path.join(scenariosDir, path.basename(name)), content);
    res.json({ ok: true, path: path.basename(name) });
  } catch (e) { wErr(res, e); }
});

// ── Testcase management ───────────────────────────────────────────────────────
router.get('/testcases/status', (req, res) => {
  try { res.json({ ok: true, snapshot: tcLoad(req) }); } catch (e) { wErr(res, e); }
});

router.post('/testcases/add-group', (req, res) => {
  try {
    const data = tcLoad(req);
    const grp  = { id: crypto.randomUUID(), name: req.body?.name || 'Group', cases: [] };
    data.push(grp);
    tcSave(req, data);
    res.json({ ok: true, group: grp, status: 'group-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/add', (req, res) => {
  try {
    const data   = tcLoad(req);
    const grpIdx = req.body?.groupIndex ?? 0;
    const tc     = { id: crypto.randomUUID(), name: req.body?.name || 'Test', steps: req.body?.steps || [] };
    if (data[grpIdx]) {
      if (!data[grpIdx].cases) data[grpIdx].cases = [];
      data[grpIdx].cases.push(tc);
    }
    tcSave(req, data);
    res.json({ ok: true, testCase: tc, status: 'testcase-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/select', (_req, res) => res.json({ ok: true, status: 'testcase-selected' }));

router.post('/testcases/save-current', (req, res) => {
  try {
    const { groupIndex = 0, tcIndex = 0, steps } = req.body || {};
    const data  = tcLoad(req);
    const grp   = data[groupIndex];
    if (!grp) return res.status(400).json({ ok: false, error: 'group not found' });
    const cases = grp.cases || grp.testCases || [];
    if (!cases[tcIndex]) return res.status(400).json({ ok: false, error: 'test case not found' });
    cases[tcIndex] = { ...cases[tcIndex], steps: steps ?? seqLoad(req) };
    if (!grp.cases) grp.testCases = cases; else grp.cases = cases;
    tcSave(req, data);
    res.json({ ok: true, status: 'current-saved' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/delete', (req, res) => {
  try {
    const data = tcLoad(req);
    const { groupIndex, testCaseIndex } = req.body || {};
    if (testCaseIndex !== undefined && groupIndex !== undefined) {
      const grp = data[groupIndex];
      if (grp) { const cases = grp.cases || grp.testCases; if (cases) cases.splice(testCaseIndex, 1); }
    } else if (groupIndex !== undefined) {
      data.splice(groupIndex, 1);
    }
    tcSave(req, data);
    res.json({ ok: true, status: 'deleted' });
  } catch (e) { wErr(res, e); }
});

// ── Testcase JSON import ──────────────────────────────────────────────────────
router.post('/testcases/import', (req, res) => {
  try {
    let incoming = req.body?.groups || req.body;
    if (!Array.isArray(incoming)) incoming = incoming ? [incoming] : [];
    const cur = tcLoad(req);
    incoming.forEach(g => {
      if (!g || !g.name) return;
      if (!g.id) g = { ...g, id: crypto.randomUUID() };
      const cases = (g.cases || g.testCases || []).map(c => c.id ? c : { ...c, id: crypto.randomUUID() });
      g = { ...g, cases };
      const i = cur.findIndex(x => x.name === g.name);
      if (i >= 0) cur[i] = { ...cur[i], ...g }; else cur.push(g);
    });
    fs.writeFileSync(tcFile(req), JSON.stringify(cur, null, 2));
    res.json({ ok: true, count: incoming.length });
  } catch (e) { wErr(res, e); }
});

// ── App / Sequence status ─────────────────────────────────────────────────────
router.get('/app/status', (req, res) => {
  try { res.json({ ok: true, selectedTabIndex: 0, sequenceCount: seqLoad(req).length }); } catch (e) { wErr(res, e); }
});

router.get('/sequence/status', (req, res) => {
  try {
    const items = seqLoad(req).map((ev, i) => ({
      index: i, kind: 'Event', name: ev.name || ev.eventType || 'event',
      protocol: ev.protocol || '', description: ev.label || ev.description || '', isChecked: true,
    }));
    res.json({ ok: true, items });
  } catch (e) { wErr(res, e); }
});

router.get('/sequence/full', (req, res) => {
  try { res.json({ ok: true, items: seqLoad(req).map((ev, i) => ({ index: i, ...ev })) }); } catch (e) { wErr(res, e); }
});

router.post('/sequence/run', async (req, res) => {
  try {
    const items = seqLoad(req);
    if (!items.length) return res.json({ ok: false, error: 'Sequence is empty' });
    const file   = path.join(req.app.locals.testsDir, 'test-cases.json');
    const saved  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const synth  = { id: '__sequence__', name: '__sequence__', steps: items };
    const idx    = saved.findIndex(t => t.id === '__sequence__');
    if (idx >= 0) saved[idx] = synth; else saved.push(synth);
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    req.app.locals.autoEngine.runTest('__sequence__').catch(() => {});
    res.json({ ok: true, status: 'started' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/add', (req, res) => {
  try {
    const items = seqLoad(req);
    items.push(req.body || {});
    seqSave(req, items);
    res.json({ ok: true, status: 'event-added', index: items.length - 1 });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/remove', (req, res) => {
  try {
    const items = seqLoad(req);
    const idx   = req.body?.index ?? -1;
    if (idx >= 0 && idx < items.length) items.splice(idx, 1);
    seqSave(req, items);
    res.json({ ok: true, status: 'event-removed' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/events/clear', (req, res) => {
  try { seqSave(req, []); res.json({ ok: true, status: 'events-cleared' }); } catch (e) { wErr(res, e); }
});

router.post('/sequence/import', (req, res) => {
  try {
    let incoming = req.body?.items || req.body;
    if (!Array.isArray(incoming)) incoming = incoming ? [incoming] : [];
    seqSave(req, incoming);
    res.json({ ok: true, count: incoming.length });
  } catch (e) { wErr(res, e); }
});

// ── Ports link status ─────────────────────────────────────────────────────────
router.get('/ports/link-status', (_req, res) => res.redirect(307, '/api/mdio/link-status'));

module.exports = router;
