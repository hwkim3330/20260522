'use strict';

const fs = require('fs');
const path = require('path');

const local = process.env.LOCAL_URL || 'http://localhost:8080';
const peer = process.env.PEER_URL || 'http://172.31.51.213:8080';
const count = Number(process.env.FRAMES || 20);
const trials = Number(process.env.TRIALS || 3);

const directions = [
  { name: 'Local enp1s0f1 -> Peer 이더넷 2', srcBase: local, dstBase: peer, srcIf: 'enp1s0f1', srcMac: 'a0:36:9f:a8:e4:a9', srcIp: '169.254.141.14', dstIf: '이더넷 2' },
  { name: 'Local enp1s0f3 -> Peer 이더넷', srcBase: local, dstBase: peer, srcIf: 'enp1s0f3', srcMac: 'a0:36:9f:a8:e4:ab', srcIp: '169.254.12.243', dstIf: '이더넷' },
  { name: 'Peer 이더넷 2 -> Local enp1s0f1', srcBase: peer, dstBase: local, srcIf: '이더넷 2', srcMac: 'c8:4d:44:20:40:5b', srcIp: '169.254.23.158', dstIf: 'enp1s0f1' },
  { name: 'Peer 이더넷 -> Local enp1s0f3', srcBase: peer, dstBase: local, srcIf: '이더넷', srcMac: 'c8:4d:44:26:3b:a6', srcIp: '169.254.204.140', dstIf: 'enp1s0f3' }
];

async function req(method, url, body, timeout = 12000) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function textOf(row) {
  try { return Buffer.from(row.frameHex || '', 'hex').toString('utf8'); }
  catch { return ''; }
}

async function runOne(d, trial) {
  const safeIf = d.srcIf.replace(/[^a-zA-Z0-9]/g, '_');
  const marker = `KETI_GRAPH_${trial}_${safeIf}_${Date.now()}`;
  await req('POST', `${d.dstBase}/api/capture/stop`, {}, 4000).catch(() => {});
  await req('POST', `${d.dstBase}/api/capture/clear`, {}, 4000).catch(() => {});
  const start = await req('POST', `${d.dstBase}/api/capture/start`, { interfaces: [d.dstIf] }, 8000)
    .catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message } }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const sendStarted = Date.now();
  const send = await req('POST', `${d.srcBase}/api/send`, {
    interface: d.srcIf,
    protocol: 'udp',
    dstMac: 'ff:ff:ff:ff:ff:ff',
    srcMac: d.srcMac,
    srcIp: d.srcIp,
    dstIp: '169.254.255.255',
    srcPort: 46100,
    dstPort: 56100,
    count,
    intervalMs: 50,
    payload: { mode: 'text', data: marker }
  }, 15000).catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message } }));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await req('POST', `${d.dstBase}/api/capture/stop`, {}, 6000).catch(() => {});
  const cap = await req('GET', `${d.dstBase}/api/capture/packets?limit=3000`, null, 10000)
    .catch((e) => ({ ok: false, status: 'ERR', data: { error: e.message, rows: [] } }));
  const rows = cap.data.rows || [];
  const matches = rows.filter((row) => textOf(row).includes(marker));
  const byIface = {};
  for (const row of matches) byIface[row.interface || 'unknown'] = (byIface[row.interface || 'unknown'] || 0) + 1;
  return {
    direction: d.name,
    trial,
    sent: send.data.framesSent || send.data.stdout?.framesSent || 0,
    expected: count,
    matched: matches.length,
    captureRows: rows.length,
    lossPct: Number((100 * (count - matches.length) / count).toFixed(1)),
    startOk: start.ok,
    sendOk: send.ok,
    captureOk: cap.ok,
    elapsedMs: Date.now() - sendStarted,
    byIface,
    error: start.data.error || send.data.error || cap.data.error || ''
  };
}

function summarize(results) {
  return directions.map((d) => {
    const rows = results.filter((r) => r.direction === d.name);
    const sent = rows.reduce((sum, r) => sum + r.expected, 0);
    const matched = rows.reduce((sum, r) => sum + r.matched, 0);
    return {
      direction: d.name,
      sent,
      matched,
      rxPct: Number((100 * matched / sent).toFixed(1)),
      lossPct: Number((100 * (sent - matched) / sent).toFixed(1)),
      trials: rows
    };
  });
}

function writeReport(report) {
  const reportsDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'switch-deep-latest.json'), JSON.stringify(report, null, 2));
  const labels = report.summary.map((s) => s.direction);
  const rx = report.summary.map((s) => s.rxPct);
  const loss = report.summary.map((s) => s.lossPct);
  const totalSent = report.summary.reduce((sum, s) => sum + s.sent, 0);
  const totalMatched = report.summary.reduce((sum, s) => sum + s.matched, 0);
  const rows = report.summary.map((s) =>
    `<tr><td>${s.direction}</td><td>${s.matched}/${s.sent}</td><td>${s.rxPct}%</td><td>${s.lossPct}%</td><td>${s.trials.map((t) => `${t.matched}/${t.expected}${t.error ? ` (${t.error})` : ''}`).join(' · ')}</td></tr>`
  ).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Switch Deep Test Report</title><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script><style>body{margin:24px;font:14px/1.45 system-ui;color:#17202a;background:#f6f8fb}.wrap{max-width:1180px;margin:auto}.hero{background:linear-gradient(135deg,#10262c,#0f6f78);color:white;border-radius:20px;padding:22px 24px;box-shadow:0 18px 45px #0f172a22}.hero h1{margin:0 0 6px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.card,.chart,table{background:white;border:1px solid #d9e2ea;border-radius:16px;box-shadow:0 4px 16px #0f172a10}.card{padding:14px}.card span{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:800}.card strong{display:block;font-size:26px}.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}.chart{padding:16px}table{width:100%;border-collapse:separate;border-spacing:0;margin-top:16px;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #e5edf3;text-align:left}th{background:#edf6f7;font-size:12px;text-transform:uppercase;color:#456}td:nth-child(n+2){font-family:ui-monospace,SFMono-Regular,monospace}@media(max-width:900px){.cards,.charts{grid-template-columns:1fr}}</style></head><body><div class="wrap"><div class="hero"><h1>Switch Deep Test Report</h1><div>${report.generatedAt}</div><div>Local ${report.local} · Peer ${report.peer} · ${report.trials} trials · ${report.count} frames/trial</div></div><div class="cards"><div class="card"><span>Total Frames</span><strong>${totalSent}</strong></div><div class="card"><span>Matched</span><strong>${totalMatched}</strong></div><div class="card"><span>Overall RX</span><strong>${(100 * totalMatched / totalSent).toFixed(1)}%</strong></div><div class="card"><span>Directions</span><strong>${report.summary.length}</strong></div></div><div class="charts"><div class="chart"><h3>Receive Rate by Direction</h3><canvas id="rx"></canvas></div><div class="chart"><h3>Loss Rate by Direction</h3><canvas id="loss"></canvas></div></div><table><thead><tr><th>Direction</th><th>Matched</th><th>RX</th><th>Loss</th><th>Trials</th></tr></thead><tbody>${rows}</tbody></table></div><script>const labels=${JSON.stringify(labels)};new Chart(document.getElementById('rx'),{type:'bar',data:{labels,datasets:[{label:'RX %',data:${JSON.stringify(rx)},backgroundColor:'#0f6f78'}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}});new Chart(document.getElementById('loss'),{type:'bar',data:{labels,datasets:[{label:'Loss %',data:${JSON.stringify(loss)},backgroundColor:'#b9651a'}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}});</script></body></html>`;
  fs.writeFileSync(path.join(reportsDir, 'switch-deep-latest.html'), html);
}

(async () => {
  const results = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const direction of directions) {
      const result = await runOne(direction, trial);
      results.push(result);
      console.log(`${result.direction} trial ${trial}: ${result.matched}/${result.expected} loss=${result.lossPct}% rows=${result.captureRows} err=${result.error}`);
    }
  }
  const report = { generatedAt: new Date().toISOString(), local, peer, count, trials, results };
  report.summary = summarize(results);
  writeReport(report);
  console.log('Report: /reports/switch-deep-latest.html');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
