'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

// Counter read via serial port
// Sends "read_cnt" or "read_cnt <N>" command via serialWrite worker command,
// then collects response lines from workerHub serial-rx events for up to 8 s.
// Response format from firmware: REGISTER_NAME [A: 0xADDR, D: 0xVALUE]
// (matches C# CountViewerViewModel.LineRegex)

const LINE_RE = /^(\w+)\s+\[A:\s*(0x[\dA-Fa-f]+)\s*,\s*D:\s*(0x[\dA-Fa-f]+)\]/;

// ── GET /api/counter/read?port=all|0-5 ───────────────────────────────────────
router.get('/counter/read', async (req, res) => {
  const portParam = (req.query.port || 'all').toString().trim().toLowerCase();
  const cmd = portParam === 'all' ? 'read_cnt' : `read_cnt ${portParam}`;

  try {
    const { localCmd, localWorkerId, workerHub } = req.app.locals;

    // Send the command via serialWrite (matches tty.js pattern: camelCase command)
    // text field is the string to send; the C# worker appends or expects CR
    await localCmd('serialWrite', { text: cmd + '\r' }, 5000);

    // Collect serial-rx events from the worker for up to 8 seconds
    const deadline = Date.now() + 8000;
    let accumulated = '';
    const counters = [];
    let lastCount = -1;
    let idleStreak = 0;

    await new Promise((resolve) => {
      const onEvent = (payload) => {
        if (payload?.kind !== 'serial') return;
        if (payload.rxType === 'rx' && payload.hex) {
          const bytes = Buffer.from(payload.hex, 'hex');
          accumulated += bytes.toString('utf8');
          idleStreak = 0;
        }
      };

      workerHub.events.on(`event:${localWorkerId}`, onEvent);

      const tick = setInterval(() => {
        // Parse accumulated text
        const lines = accumulated.split(/\r?\n/);
        accumulated = lines.pop() || ''; // keep partial last line

        for (const line of lines) {
          const m = LINE_RE.exec(line.trim());
          if (!m) continue;
          const name   = m[1];
          const addr   = m[2];
          const valHex = m[3];
          const valDec = parseInt(valHex.replace(/^0x/i, ''), 16) || 0;

          const underIdx = name.indexOf('_');
          let group = underIdx > 0 ? name.slice(0, underIdx) : name;
          if (group.toUpperCase().startsWith('FBR')) group = 'FBR';

          counters.push({ group, name, address: addr, value: valHex, valueDec: valDec });
        }

        idleStreak++;

        // Stop when: data arrived and been stable for 2 ticks, or deadline passed
        const done = Date.now() >= deadline || (counters.length > 0 && counters.length === lastCount && idleStreak >= 2);
        lastCount = counters.length;
        if (done) {
          clearInterval(tick);
          workerHub.events.off(`event:${localWorkerId}`, onEvent);
          resolve();
        }
      }, 200);

      // Safety timeout
      setTimeout(() => {
        clearInterval(tick);
        workerHub.events.off(`event:${localWorkerId}`, onEvent);
        resolve();
      }, 8500);
    });

    const portNum = portParam === 'all' ? null : parseInt(portParam, 10);
    const result = { ok: true, counters };
    if (portNum !== null) result.port = portNum;
    res.json(result);
  } catch (e) { wErr(res, e); }
});

module.exports = router;
