const $ = (id) => document.getElementById(id);

const state = {
  interfaces: [],
  captureInterfaces: new Set(),
  captureRows: [],
  captureTimer: null,
  serialTimer: null,
  serialConnected: false,
  // packet generator
  packets: [],
  selectedPacketIdx: -1,
  selectedBlockType: null,
  selectedBlockIdx: -1,
  lastFrameHex: '',
  layerRanges: new Map(),
  // TC mode
  tcPackets: [],
  tcActivePath: '',
  tcOriginalRefs: new Set(),
  activeList: 'pg',  // 'pg' | 'tc'
  // scenario
  tcGroups: [],
  tcSeqList: [],
  selectedTcSeqIdx: -1,
  selectedSeqTcIdx: -1,
  tcNextPacketIdx: 0,
  tcNextFrameRef: 0,
  seqItems: [],
  seqOriginalItems: [],
  seqItemHeaders: [],
  selectedSeqRowIdx: -1,
  seqRunning: false,
  sendRunning: false,
  _runAbort: false,
};

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const tray = $('toastTray');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  tray.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setStatus(text, ok = true) {
  const s = $('status'); if (s) s.textContent = text;
  const dot = $('serverState'); if (dot) dot.classList.toggle('bad', !ok);
}

function populateInterfaceSelects() {
  const opts = state.interfaces.length
    ? state.interfaces.map(i => `<option value="${esc(i.name)}">${esc(i.name)}${i.state === 'up' ? ' ●' : ''}</option>`).join('')
    : '<option value="">-- No interfaces --</option>';
  [$('scInterface')].filter(Boolean).forEach(s => { s.innerHTML = opts; });
  // update per-packet interface selects (PG tab)
  document.querySelectorAll('.pkt-iface-sel').forEach(sel => {
    const idx = Number(sel.dataset.idx);
    const cur = getActivePackets()[idx]?.interface || '';
    sel.innerHTML = '<option value="">-- iface --</option>' + (state.interfaces.map(i => `<option value="${esc(i.name)}"${i.name===cur?' selected':''}>${esc(i.name)}${i.state==='up'?' ●':''}</option>`).join(''));
    sel.value = cur;
  });
  // update per-row interface selects (scenario sequence table)
  const seqRows = _getSeqRows();
  document.querySelectorAll('.sc-row-iface-sel').forEach(sel => {
    const rowIdx = Number(sel.dataset.rowIdx);
    const cur = seqRows[rowIdx]?._iface || '';
    sel.innerHTML = '<option value="">-- iface --</option>' + state.interfaces.map(i => `<option value="${esc(i.name)}"${i.name===cur?' selected':''}>${esc(i.name)}${i.state==='up'?' ●':''}</option>`).join('');
    sel.value = cur;
  });
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function tsNow() {
  const d = new Date();
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}]`;
}

function pad2(n) { return String(n).padStart(2,'0'); }

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.view)?.classList.add('active');
      if (tab.dataset.view === 'hyperTermView') refreshSerialStatus();
      if (tab.dataset.view === 'packetGenView') {
        renderPacketList();
        updateTcUI();
      }
      if (tab.dataset.view === 'scenarioView') {
        const tcActive = state.selectedSeqTcIdx >= 0 && state.selectedSeqTcIdx < state.tcSeqList.length;
        if (!tcActive && !state.selectedCsvPath) {
          state.selectedSeqTcIdx = -1;
          state.seqItems = [];
          const tbody = $('sequenceRows');
          if (tbody) tbody.innerHTML = '';
          const titleEl = $('scDetailTitle');
          if (titleEl) titleEl.textContent = 'TEST SEQUENCE — (select a TC)';
          $('csvTree')?.querySelectorAll('.csv-leaf, .csv-root-item')?.forEach(e => e.classList.remove('selected'));
        } else if (!tcActive && state.seqItems.length) {
          renderCsvSequence(state.seqItems);
        }
        loadCsvTree();
      }
      if (tab.dataset.view !== 'hyperTermView') {
        if (_intrPollTimer) { clearInterval(_intrPollTimer); _intrPollTimer = null; const b = $('rv-intr-raw-poll'); if (b) { b.textContent = '▶ Poll'; b.className = 'small'; } }
      }
    });
  });
}

// ── Interfaces ────────────────────────────────────────────────────────────────
async function refreshInterfaces() {
  try {
    const data = await api('/api/interfaces');
    state.interfaces = data.interfaces || [];
    populateInterfaceSelects();
    await refreshCaptureStatus();
    setStatus(`Connected — ${state.interfaces.length} interfaces`);
  } catch (err) { setStatus(`Interfaces error: ${err.message}`, false); }
}

// ── Packet Generator — block model ───────────────────────────────────────────
let _dragBlockIdx = -1;  // index of block being dragged within blockList

const BLOCK_ABBR = { Ethernet:'ETH', VLAN:'VLN', IPv4:'IP4', IPv6:'IP6', TCP:'TCP', UDP:'UDP', ICMP:'ICM', ARP:'ARP', Payload:'PLD' };

const BLOCK_FIELDS = {
  Ethernet: [
    { id:'dstMac',    label:'Dst MAC',    type:'text',   def:'FF:FF:FF:FF:FF:FF' },
    { id:'srcMac',    label:'Src MAC',    type:'text',   def:'00:00:00:00:00:00' },
    { id:'etherType', label:'EtherType',  type:'text',   def:'0x0800' },
  ],
  ARP: [
    { id:'operation', label:'Operation (1=req)', type:'number', def:'1' },
    { id:'senderMac', label:'Sender MAC',         type:'text',   def:'00:00:00:00:00:00' },
    { id:'senderIp',  label:'Sender IP',          type:'text',   def:'0.0.0.0' },
    { id:'targetMac', label:'Target MAC',         type:'text',   def:'00:00:00:00:00:00' },
    { id:'targetIp',  label:'Target IP',          type:'text',   def:'0.0.0.0' },
  ],
  IPv4: [
    { id:'srcIp',    label:'Src IP',    type:'text',   def:'192.168.1.1' },
    { id:'dstIp',    label:'Dst IP',    type:'text',   def:'192.168.1.2' },
    { id:'protocol', label:'Protocol',  type:'text',   def:'udp' },
    { id:'ttl',      label:'TTL',       type:'number', def:'64' },
    { id:'tos',      label:'TOS',       type:'number', def:'0' },
  ],
  ICMP: [
    { id:'icmpType', label:'Type', type:'number', def:'8' },
    { id:'icmpCode', label:'Code', type:'number', def:'0' },
  ],
  TCP: [
    { id:'srcPort', label:'Src Port', type:'number', def:'1234' },
    { id:'dstPort', label:'Dst Port', type:'number', def:'80' },
    { id:'flags',   label:'Flags',    type:'number', def:'2' },
    { id:'seqNum',  label:'Seq #',    type:'number', def:'0' },
    { id:'ackNum',  label:'Ack #',    type:'number', def:'0' },
  ],
  UDP: [
    { id:'srcPort', label:'Src Port', type:'number', def:'12345' },
    { id:'dstPort', label:'Dst Port', type:'number', def:'50000' },
  ],
  VLAN: [
    { id:'vlanId',   label:'VLAN ID',  type:'number', def:'100' },
    { id:'priority', label:'Priority', type:'number', def:'0' },
  ],
  Payload: [
    { id:'mode', label:'Mode (text/hex)', type:'text', def:'text' },
    { id:'data', label:'Data',            type:'text', def:'' },
  ],
};

function makePacket() {
  return {
    id: Date.now() + Math.random(),
    name: `Packet-${state.packets.length}`,
    blocks: [{ type:'Ethernet', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', etherType:'0x0800' }],
    status: '',
    checked: false,
    interface: '',
  };
}

function renderBlockList(pkt) {
  const list = $('blockList');
  if (!list) return;
  list.innerHTML = '';
  if (!pkt) return;
  pkt.blocks.forEach((block, bi) => {
    const div = document.createElement('div');
    div.className = `proto-block${state.selectedBlockIdx === bi ? ' selected' : ''}`;
    div.dataset.proto = block.type;
    div.draggable = true;
    div.innerHTML = `
      <span class="block-abbr">${BLOCK_ABBR[block.type] || block.type.slice(0,3).toUpperCase()}</span>
      <span class="block-name">${block.type}</span>
      <span class="block-del" title="Remove">✕</span>
      <span class="block-nav">
        <span class="block-nav-l" title="Move left">←</span>
        <span class="block-nav-r" title="Move right">→</span>
      </span>`;
    div.addEventListener('click', e => {
      const cl = e.target.classList;
      if (cl.contains('block-del') || cl.contains('block-nav-l') || cl.contains('block-nav-r') || cl.contains('block-nav')) return;
      selectBlock(bi);
    });
    div.querySelector('.block-del').addEventListener('click', e => { e.stopPropagation(); removeBlockAt(bi); });
    div.querySelector('.block-nav-l').addEventListener('click', e => { e.stopPropagation(); moveBlockLeft(bi); });
    div.querySelector('.block-nav-r').addEventListener('click', e => { e.stopPropagation(); moveBlockRight(bi); });
    // Drag-and-drop reordering within blockList
    div.addEventListener('dragstart', e => {
      _dragBlockIdx = bi; div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(bi));
    });
    div.addEventListener('dragend', () => { div.classList.remove('dragging'); _dragBlockIdx = -1; });
    div.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); div.classList.remove('drag-over');
      if (_dragBlockIdx >= 0 && _dragBlockIdx !== bi) {
        const p2 = getActivePackets()[state.selectedPacketIdx]; if (!p2) return;
        const [moved] = p2.blocks.splice(_dragBlockIdx, 1);
        const insertAt = _dragBlockIdx < bi ? bi - 1 : bi;
        p2.blocks.splice(insertAt, 0, moved);
        state.selectedBlockIdx = insertAt;
        state.lastFrameHex = '';
        state.layerRanges = new Map();
        _dragBlockIdx = -1;
        renderBlockList(p2); selectBlock(insertAt);
      } else if (_dragBlockIdx < 0) {
        const proto = e.dataTransfer.getData('proto');
        if (proto) addProtoBlockToPacket(proto);
      }
      _dragBlockIdx = -1;
    });
    list.appendChild(div);
  });
}

function selectBlock(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) return;
  const block = pkt.blocks[bi];
  if (!block) return;
  state.selectedBlockType = block.type;
  state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  renderProtoFields(block);
  const t = $('fieldsTitle'); if (t) t.textContent = `Protocol Fields — ${block.type}`;
  // Always refresh the hex highlight; use cache if available, else fetch
  if (state.lastFrameHex) {
    const ranges = calcLayerRanges(pkt.blocks);
    const range  = ranges.get(block.type);
    const hexEl  = $('hexdump');
    if (hexEl) hexEl.innerHTML = renderHexHTML(state.lastFrameHex, range ? range.start : -1, range ? range.end : -1);
  }
  previewFrame().catch(() => {});
}

function renderProtoFields(block) {
  const body = $('protoFieldsBody');
  if (!body) return;
  const fields = BLOCK_FIELDS[block.type] || [];
  if (!fields.length) { body.innerHTML = '<p style="color:var(--muted);font-size:11px;padding:8px;">No configurable fields.</p>'; return; }
  body.innerHTML = fields.map(f => `
    <div class="field">
      <label>${esc(f.label)}</label>
      <input id="pf-${f.id}" type="${f.type}" value="${esc(block[f.id] ?? f.def)}" placeholder="${esc(f.def)}">
    </div>`).join('');
  fields.forEach(f => {
    const inp = $(`pf-${f.id}`);
    if (!inp) return;
    inp.addEventListener('change', () => {
      const pkt = getActivePackets()[state.selectedPacketIdx];
      const blk = pkt?.blocks[state.selectedBlockIdx];
      if (blk) {
        blk[f.id] = f.type === 'number' ? Number(inp.value) : inp.value;
        state.lastFrameHex = '';
        state.layerRanges = new Map();
        previewFrame().catch(() => {});
      }
    });
  });
}

function addProtoBlockToPacket(proto) {
  if (state.selectedPacketIdx < 0) { toast('Add a packet first', 'warn'); return; }
  const pkt = getActivePackets()[state.selectedPacketIdx];
  const defaults = {};
  (BLOCK_FIELDS[proto] || []).forEach(f => { defaults[f.id] = f.type === 'number' ? Number(f.def) : f.def; });
  pkt.blocks.push({ type: proto, ...defaults });
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  renderBlockList(pkt);
  selectBlock(pkt.blocks.length - 1);
  renderPacketList();
}

function removeBlockAt(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) return;
  pkt.blocks.splice(bi, 1);
  state.selectedBlockIdx = Math.min(bi, pkt.blocks.length - 1);
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  if (pkt.blocks.length === 0) { state.selectedBlockIdx = -1; state.selectedBlockType = null; const b = $('protoFieldsBody'); if (b) b.innerHTML = ''; }
  renderBlockList(pkt);
  if (state.selectedBlockIdx >= 0) selectBlock(state.selectedBlockIdx);
  renderPacketList();
}

function moveBlockLeft(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt || bi <= 0) return;
  [pkt.blocks[bi-1], pkt.blocks[bi]] = [pkt.blocks[bi], pkt.blocks[bi-1]];
  if (state.selectedBlockIdx === bi) state.selectedBlockIdx = bi - 1;
  else if (state.selectedBlockIdx === bi - 1) state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  state.lastFrameHex = '';
  previewFrame().catch(() => {});
}

function moveBlockRight(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt || bi >= pkt.blocks.length - 1) return;
  const tmp = pkt.blocks[bi];
  pkt.blocks[bi] = pkt.blocks[bi + 1];
  pkt.blocks[bi + 1] = tmp;
  if (state.selectedBlockIdx === bi) state.selectedBlockIdx = bi + 1;
  else if (state.selectedBlockIdx === bi + 1) state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  state.lastFrameHex = '';
  previewFrame().catch(() => {});
}

function selectPacket(idx) {
  state.selectedPacketIdx = idx;
  state.selectedBlockType = null;
  state.selectedBlockIdx = -1;
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  const pkt = getActivePackets()[idx];
  renderPacketList();
  renderBlockList(pkt || null);
  const body = $('protoFieldsBody');
  if (body) body.innerHTML = pkt ? '<p style="color:var(--muted);font-size:11px;padding:8px;">Select a block above.</p>' : '';
  const t = $('fieldsTitle'); if (t) t.textContent = 'PROTOCOL FIELDS';
  const hexEl = $('hexdump'); if (hexEl) hexEl.innerHTML = '<span style="color:var(--muted)">No preview.</span>';
  const decEl = $('decodeTree'); if (decEl) decEl.innerHTML = '';
  if (pkt) previewFrame().catch(() => {});
}

function renderPacketList() {
  const tbody = $('packetListRows');
  if (!tbody) return;
  const pkts = getActivePackets();
  const isTc = state.activeList === 'tc';
  if (!pkts.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${isTc ? 'No packets in TC file.' : 'No packets. Click "Add Packet".'}</td></tr>`;
    return;
  }
  // Build FrameRef → sequence Index map so packet list numbers match the sequence table
  const seqIdxByRef = new Map();
  if (isTc) {
    for (const row of _getSeqRows()) {
      if ((row['EventType'] || '').toLowerCase() === 'packet') {
        const ref = (row['FrameRef'] || '').trim();
        if (ref && row['Index'] !== undefined) seqIdxByRef.set(ref, row['Index']);
      }
    }
  }
  tbody.innerHTML = pkts.map((pkt, i) => {
    const eth  = pkt.blocks.find(b => b.type === 'Ethernet') || {};
    const arp  = pkt.blocks.find(b => b.type === 'ARP')  || {};
    const ipv4 = pkt.blocks.find(b => b.type === 'IPv4') || {};
    const protos = pkt.blocks.map(b => {
      if (b.type === 'Ethernet') {
        const et = b.etherType ? (ETHERTYPE_NAMES[(b.etherType+'').toLowerCase()] || b.etherType) : '0x0800';
        return `ETH(${et})`;
      }
      if (b.type === 'UDP')  return `UDP(${b.srcPort||'?'}→${b.dstPort||'?'})`;
      if (b.type === 'TCP')  return `TCP(${b.srcPort||'?'}→${b.dstPort||'?'})`;
      if (b.type === 'VLAN') return `VLAN(${b.vlanId||100})`;
      return BLOCK_ABBR[b.type] || b.type;
    }).join(' › ');
    const srcTarget = eth.srcMac || arp.senderMac || ipv4.srcIp || '';
    const dstValue  = eth.dstMac || arp.targetMac || ipv4.dstIp || '';
    const res = pkt.status || '';
    const resStyle = res === 'Sent' || res === 'Pass' ? 'color:#44FF88;font-weight:600;'
                   : res === 'ERR'  || res === 'Fail' ? 'color:#FF4444;font-weight:600;'
                   : res === 'Running' ? 'color:#FFCC44;font-weight:600;' : '';
    const totalBytes = (() => {
      const ranges = calcLayerRanges(pkt.blocks);
      let max = 0;
      for (const r of ranges.values()) if (r.end > max) max = r.end;
      return max;
    })();
    const descText = totalBytes > 0 ? `${totalBytes} Byte` : '';
    const displayIdx = isTc ? (seqIdxByRef.get(pkt.name) ?? i + 1) : i;
    return `<tr class="${i === state.selectedPacketIdx ? 'selected' : ''}">
      <td><input type="checkbox" name="pkt-chk" class="pkt-chk" data-idx="${i}" ${pkt.checked ? 'checked' : ''}></td>
      <td>${displayIdx}</td>
      <td>${esc(pkt.name)}</td>
      <td style="font-size:10px;color:var(--muted);">${esc(srcTarget)}</td>
      <td style="font-size:10px;color:var(--muted);">${esc(dstValue)}</td>
      <td style="font-size:10px;">${esc(protos)}</td>
      <td><select name="pkt-iface-${i}" class="pkt-iface-sel small-select" data-idx="${i}" style="width:160px;font-size:10px;">
        <option value="">-- iface --</option>
        ${state.interfaces.map(if_ => `<option value="${esc(if_.name)}"${pkt.interface===if_.name?' selected':''}>${esc(if_.name)}${if_.state==='up'?' ●':''}</option>`).join('')}
      </select></td>
      <td style="font-size:10px;color:var(--accent);font-weight:600;">${esc(descText)}</td>
      <td style="font-size:10px;${resStyle}">${esc(res)}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', e => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT' || e.target.closest('select')) return; selectPacket(i); });
  });
  tbody.querySelectorAll('.pkt-chk').forEach(chk => {
    chk.addEventListener('change', e => { e.stopPropagation(); const p = getActivePackets()[Number(chk.dataset.idx)]; if (p) p.checked = chk.checked; });
  });
  tbody.querySelectorAll('.pkt-iface-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const idx = Number(sel.dataset.idx);
      const p = getActivePackets()[idx];
      if (p) p.interface = sel.value;
      updateEstimatedTime();
    });
  });
}

function updateEstimatedTime() {
  const el = $('pgEstMs');
  if (!el) return;
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const count = getActivePackets().length;
  if (!count || !periodMs) { el.textContent = '—'; return; }
  el.textContent = `${count * periodMs} ms`;
}

// Re-sorts state.tcPackets to match the packet event order in the current sequence.
function _syncTcPacketsToSeq() {
  if (state.activeList !== 'tc') return;
  const seqRefs = _getSeqRows()
    .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
    .map(r => (r['FrameRef'] || '').trim())
    .filter(Boolean);
  const pktByName = new Map(state.tcPackets.map(p => [p.name, p]));
  const ordered = seqRefs.map(ref => pktByName.get(ref)).filter(Boolean);
  const inSeq = new Set(seqRefs);
  for (const p of state.tcPackets) { if (!inSeq.has(p.name)) ordered.push(p); }
  state.tcPackets = ordered;
}

// Resets tcNextFrameRef to (max numeric suffix among current packets) + 1.
function _resetTcNextRef() {
  const ap = getActivePackets();
  let maxRef = -1;
  for (const p of ap) {
    const m = (p.name || '').match(/(\d+)$/);
    if (m) maxRef = Math.max(maxRef, parseInt(m[1], 10));
  }
  state.tcNextFrameRef  = maxRef + 1;
  state.tcNextPacketIdx = ap.length;
}

function addPacket() {
  const ap = getActivePackets();
  const insertAt = state.activeList === 'tc'
    ? (state.selectedPacketIdx >= 0 ? state.selectedPacketIdx + 1 : ap.length)
    : ap.length;
  let newPkt;
  if (state.activeList === 'tc') {
    newPkt = {
      id: Date.now() + Math.random(),
      name: `Packet_${state.tcNextFrameRef++}`,
      originalOrder: 0,
      blocks: [{ type:'Ethernet', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', etherType:'0x0800' }],
      status: '',
      checked: false,
      interface: '',
    };
    ap.splice(insertAt, 0, newPkt);
    // Insert Packet event row after selected sequence row (or at end), then advance cursor
    const rows = _getSeqRows();
    const seqAt = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
    rows.splice(seqAt, 0, { Index: '', Name: newPkt.name, EventType: 'Packet', MAC: '-', FrameRef: newPkt.name, Timeout: '' });
    state.selectedSeqRowIdx = seqAt;
    _setSeqRows(rows);
    _syncTcPacketsToSeq();
    const newIdx = state.tcPackets.indexOf(newPkt);
    updateEstimatedTime();
    selectPacket(newIdx >= 0 ? newIdx : 0);
  } else {
    newPkt = makePacket();
    ap.push(newPkt);
    updateEstimatedTime();
    selectPacket(insertAt);
  }
  toast('Packet added', 'ok');
}
function deletePacket() {
  if (state.selectedPacketIdx < 0) { toast('No packet selected','warn'); return; }
  const ap = getActivePackets();
  const pkt = ap[state.selectedPacketIdx];
  if (state.activeList === 'tc' && pkt) {
    const rows = _getSeqRows();
    const si = rows.findIndex(r => r['FrameRef'] === pkt.name && (r['EventType'] || '').toLowerCase() === 'packet');
    if (si >= 0) { rows.splice(si, 1); _setSeqRows(rows); }
  }
  ap.splice(state.selectedPacketIdx, 1);
  if (state.activeList === 'tc') _resetTcNextRef();
  updateEstimatedTime();
  selectPacket(Math.min(state.selectedPacketIdx, ap.length - 1));
}
function movePacket(dir) {
  const ap = getActivePackets();
  const i = state.selectedPacketIdx, j = i + dir;
  if (i < 0 || j < 0 || j >= ap.length) return;
  if (state.activeList === 'tc') {
    const pkt = ap[i];
    const rows = _getSeqRows();
    const si = rows.findIndex(r => r['FrameRef'] === ap[i].name && (r['EventType'] || '').toLowerCase() === 'packet');
    const sj = rows.findIndex(r => r['FrameRef'] === ap[j].name && (r['EventType'] || '').toLowerCase() === 'packet');
    if (si >= 0 && sj >= 0) {
      [rows[si], rows[sj]] = [rows[sj], rows[si]];
      _setSeqRows(rows);
      _syncTcPacketsToSeq();
      const newIdx = state.tcPackets.indexOf(pkt);
      state.selectedPacketIdx = newIdx >= 0 ? newIdx : j;
      renderPacketList();
      renderBlockList(state.tcPackets[state.selectedPacketIdx]);
    }
    return;
  }
  [ap[i], ap[j]] = [ap[j], ap[i]];
  state.selectedPacketIdx = j;
  renderPacketList();
  renderBlockList(ap[j]);
}
function duplicatePacket() {
  const ap  = getActivePackets();
  const pkt = ap[state.selectedPacketIdx];
  if (!pkt) { toast('No packet selected','warn'); return; }
  const c = JSON.parse(JSON.stringify(pkt));
  c.id = Date.now() + Math.random();
  c.status = '';
  if (state.activeList === 'tc') {
    c.name = `Packet_${state.tcNextFrameRef++}`;
    c.originalOrder = state.tcNextPacketIdx++;
    ap.splice(state.selectedPacketIdx + 1, 0, c);
    const rows = _getSeqRows();
    const seqAt = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
    rows.splice(seqAt, 0, { Index: '', Name: c.name, EventType: 'Packet', MAC: '-', FrameRef: c.name, Timeout: '' });
    state.selectedSeqRowIdx = seqAt;
    _setSeqRows(rows);
    _syncTcPacketsToSeq();
    const newIdx = state.tcPackets.indexOf(c);
    updateEstimatedTime();
    selectPacket(newIdx >= 0 ? newIdx : state.selectedPacketIdx + 1);
    toast('Packet duplicated', 'ok');
    return;
  } else {
    const existingNames = new Set(ap.map(p => p.name));
    let n = 1;
    while (existingNames.has(`${pkt.name} (${n})`)) n++;
    c.name = `${pkt.name} (${n})`;
    ap.splice(state.selectedPacketIdx + 1, 0, c);
  }
  updateEstimatedTime();
  selectPacket(state.selectedPacketIdx + 1);
  toast('Packet duplicated', 'ok');
}

function deleteSelectedPackets() {
  const ap = getActivePackets();
  const filtered = ap.filter(p => !p.checked);
  const removed  = ap.length - filtered.length;
  if (!removed) { toast('No packets checked', 'warn'); return; }
  if (state.activeList === 'tc') {
    // Remove seq rows for each deleted packet
    const deletedNames = new Set(ap.filter(p => p.checked).map(p => p.name));
    const rows = _getSeqRows().filter(r => !(deletedNames.has(r['FrameRef']) && (r['EventType'] || '').toLowerCase() === 'packet'));
    _setSeqRows(rows);
  }
  setActivePackets(filtered);
  if (state.activeList === 'tc') _resetTcNextRef();
  state.selectedPacketIdx = Math.min(state.selectedPacketIdx, filtered.length - 1);
  if (filtered.length === 0) selectPacket(-1);
  else selectPacket(state.selectedPacketIdx);
  updateEstimatedTime();
  toast(`Deleted ${removed} packet(s)`, 'ok');
}

function deleteAllPackets() {
  if (!getActivePackets().length) return;
  if (!confirm('Delete all packets?')) return;
  if (state.activeList === 'tc') {
    // Remove all Packet event rows from sequence
    const rows = _getSeqRows().filter(r => (r['EventType'] || '').toLowerCase() !== 'packet');
    _setSeqRows(rows);
    state.tcNextFrameRef  = 0;
    state.tcNextPacketIdx = 0;
  }
  setActivePackets([]);
  state.selectedPacketIdx = -1;
  selectPacket(-1);
  updateEstimatedTime();
  toast('All packets deleted', 'ok');
}

function buildPacketPayload(pkt) {
  const blocks   = pkt?.blocks || [];
  const iface    = pkt.interface || '';
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const eth      = blocks.find(b => b.type === 'Ethernet') || {};
  const ipv4     = blocks.find(b => b.type === 'IPv4')     || {};
  const tcpB     = blocks.find(b => b.type === 'TCP');
  const udpB     = blocks.find(b => b.type === 'UDP');
  const icmpB    = blocks.find(b => b.type === 'ICMP');
  const arpB     = blocks.find(b => b.type === 'ARP');
  const vlanB    = blocks.find(b => b.type === 'VLAN');
  const plB      = blocks.find(b => b.type === 'Payload') || {};
  let protocol   = 'raw';
  if (udpB)  protocol = 'udp';
  if (tcpB)  protocol = 'tcp';
  if (icmpB) protocol = 'icmp';
  if (arpB)  protocol = 'arp';
  const p = { protocol, interface: iface,
    dstMac: eth.dstMac || 'FF:FF:FF:FF:FF:FF', srcMac: eth.srcMac || '00:00:00:00:00:00',
    etherType: eth.etherType || '0x0800',
    srcIp: ipv4.srcIp || '192.168.1.1', dstIp: ipv4.dstIp || '192.168.1.2',
    ttl: ipv4.ttl || 64, tos: ipv4.tos || 0, count: 1, intervalMs: periodMs,
    payload: { mode: plB.mode || 'text', data: plB.data || '' } };
  if (udpB)  p.udp  = { srcPort: udpB.srcPort || 12345, dstPort: udpB.dstPort || 50000 };
  if (tcpB)  p.tcp  = { srcPort: tcpB.srcPort || 1234,  dstPort: tcpB.dstPort || 80, flags: tcpB.flags || 2, seqNum: tcpB.seqNum || 0, ackNum: tcpB.ackNum || 0 };
  if (icmpB) p.icmp = { type: icmpB.icmpType || 8, code: icmpB.icmpCode || 0 };
  if (arpB)  p.arp  = { operation: arpB.operation || 1, senderMac: arpB.senderMac, senderIp: arpB.senderIp, targetMac: arpB.targetMac, targetIp: arpB.targetIp };
  if (vlanB) p.vlan = { enabled: true, id: vlanB.vlanId || 100, priority: vlanB.priority || 0 };
  return p;
}

function buildProfile() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  return pkt ? buildPacketPayload(pkt) : { protocol:'udp', interface:'', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', srcIp:'192.168.1.1', dstIp:'192.168.1.2', udp:{srcPort:12345,dstPort:50000}, count:1, intervalMs:0, payload:{mode:'text',data:''} };
}

// ── Hex / Decode helpers ──────────────────────────────────────────────────────

function getBlockSize(block) {
  switch (block.type) {
    case 'Ethernet': return 14;
    case 'VLAN':     return 4;
    case 'ARP':      return 28;
    case 'IPv4':     return 20;
    case 'TCP':      return 20;
    case 'UDP':      return 8;
    case 'ICMP':     return 8;
    case 'Payload': {
      const d = block.data || '';
      if ((block.mode || 'text') === 'hex') return Math.floor(d.replace(/[\s:]/g, '').length / 2);
      return new TextEncoder().encode(d).length;
    }
    default: return 0;
  }
}

function calcLayerRanges(blocks) {
  const has  = t => blocks.some(b => b.type === t);
  const getb = t => blocks.find(b => b.type === t);
  const map  = new Map();
  let off = 0;
  if (has('Ethernet')) { map.set('Ethernet', { start: off, end: off + 14 }); off += 14; }
  if (has('VLAN'))     { map.set('VLAN',     { start: off, end: off + 4  }); off += 4;  }
  if (has('ARP'))      { map.set('ARP',      { start: off, end: off + 28 }); off += 28; }
  if (has('IPv4'))     { map.set('IPv4',     { start: off, end: off + 20 }); off += 20; }
  if (has('TCP'))      { map.set('TCP',      { start: off, end: off + 20 }); off += 20; }
  else if (has('UDP')) { map.set('UDP',      { start: off, end: off + 8  }); off += 8;  }
  else if (has('ICMP')){ map.set('ICMP',     { start: off, end: off + 8  }); off += 8;  }
  if (has('Payload')) {
    const pl = getb('Payload');
    const len = getBlockSize(pl);
    map.set('Payload', { start: off, end: off + len }); off += len;
  }
  return map;
}

function renderHexHTML(hex, hiStart, hiEnd) {
  if (!hex) return '<span style="color:var(--muted)">No data.</span>';
  const bytes = hex.match(/.{1,2}/g) || [];
  const hi = (i) => hiStart >= 0 && i >= hiStart && i < hiEnd;
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const hexParts = chunk.map((b, j) => {
      const cls = hi(off + j) ? ' class="hex-hi"' : '';
      return `<span${cls}>${b}</span>`;
    });
    const pad = '   '.repeat(16 - chunk.length);
    const asciiParts = chunk.map((b, j) => {
      const n = parseInt(b, 16);
      const ch = n >= 32 && n <= 126 ? esc(String.fromCharCode(n)) : '.';
      const cls = hi(off + j) ? ' class="hex-hi"' : '';
      return `<span${cls}>${ch}</span>`;
    });
    lines.push(
      `<span class="hex-off">${off.toString(16).padStart(4, '0')}</span>  ` +
      hexParts.join(' ') + pad + `  ` +
      `<span class="hex-ascii">${asciiParts.join('')}</span>`
    );
  }
  return lines.join('\n');
}

function buildDecodeTreeDOM(container, obj, depth) {
  depth = depth || 0;
  if (typeof obj !== 'object' || obj === null) return;
  for (const [k, v] of Object.entries(obj)) {
    const isNode = typeof v === 'object' && v !== null && !Array.isArray(v);
    if (isNode) {
      const wrapper = document.createElement('div');
      const header  = document.createElement('div');
      header.className = 'dt-node';
      header.style.paddingLeft = `${depth * 14}px`;
      header.innerHTML = `<span class="dt-toggle">▾</span> <span class="dt-node-key">${esc(k)}</span>`;
      const children = document.createElement('div');
      children.className = 'dt-children';
      buildDecodeTreeDOM(children, v, depth + 1);
      header.addEventListener('click', () => {
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        header.querySelector('.dt-toggle').textContent = open ? '▸' : '▾';
      });
      wrapper.appendChild(header);
      wrapper.appendChild(children);
      container.appendChild(wrapper);
    } else {
      const item = document.createElement('div');
      item.className = 'dt-leaf';
      item.style.paddingLeft = `${depth * 14 + 16}px`;
      const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
      item.innerHTML = `<span class="dt-leaf-key">${esc(k)}</span>: <span class="dt-leaf-val">${esc(val)}</span>`;
      container.appendChild(item);
    }
  }
}

// ── Hex / Decode ──────────────────────────────────────────────────────────────
function decodeHexBasic(hex) {
  if (!hex || hex.length < 28) return null;
  const b = hex.match(/.{1,2}/g).map(x => parseInt(x, 16));
  if (b.length < 14) return null;
  const eth = {
    dstMac: b.slice(0,6).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
    srcMac: b.slice(6,12).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
    etherType: `0x${b[12].toString(16).padStart(2,'0').toUpperCase()}${b[13].toString(16).padStart(2,'0').toUpperCase()}`,
  };
  const etherType = (b[12] << 8) | b[13];
  const tree = { Ethernet: eth };
  if (etherType === 0x0806 && b.length >= 42) {
    tree.ARP = {
      operation: (b[20]<<8)|b[21],
      senderMAC: b.slice(22,28).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
      senderIP:  b.slice(28,32).join('.'),
      targetMAC: b.slice(32,38).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
      targetIP:  b.slice(38,42).join('.'),
    };
  } else if (etherType === 0x0800 && b.length >= 34) {
    const ihl = (b[14] & 0x0F) * 4;
    const proto = b[23];
    tree.IPv4 = { src: b.slice(26,30).join('.'), dst: b.slice(30,34).join('.'), protocol: proto, ttl: b[22], tos: b[21] };
    const u = 14 + ihl;
    if (proto === 17 && b.length >= u + 8)  tree.UDP  = { srcPort: (b[u]<<8)|b[u+1], dstPort: (b[u+2]<<8)|b[u+3] };
    else if (proto === 6 && b.length >= u + 20) tree.TCP  = { srcPort: (b[u]<<8)|b[u+1], dstPort: (b[u+2]<<8)|b[u+3] };
    else if (proto === 1 && b.length >= u + 4)  tree.ICMP = { type: b[u], code: b[u+1] };
  }
  return tree;
}

function formatHex(hex) {
  if (!hex) return '';
  const bytes = hex.match(/.{1,2}/g) || [];
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const ascii = chunk.map(b => { const n = parseInt(b, 16); return n >= 32 && n <= 126 ? String.fromCharCode(n) : '.'; }).join('');
    lines.push(`${off.toString(16).padStart(4,'0')}  ${chunk.join(' ').padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

function renderDecodeTree(obj, depth = 0) {
  if (typeof obj !== 'object' || obj === null) return `${obj}`;
  return Object.entries(obj).map(([k, v]) => {
    const indent = '  '.repeat(depth);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return `${indent}▸ ${k}\n${renderDecodeTree(v, depth+1)}`;
    const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
    return `${indent}  ${k}: ${val}`;
  }).join('\n');
}

async function previewFrame() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) { toast('Select a packet first', 'warn'); return; }
  try {
    const data = await api('/api/build', { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
    const out = data.stdout || data;
    const hex = out.frameHex || out.hex || '';
    state.lastFrameHex = hex;
    state.layerRanges = calcLayerRanges(pkt.blocks);

    const selBlock = pkt.blocks[state.selectedBlockIdx];
    const range    = selBlock ? state.layerRanges.get(selBlock.type) : null;
    const hiStart  = range ? range.start : -1;
    const hiEnd    = range ? range.end   : -1;

    const hexEl = $('hexdump');
    if (hexEl) hexEl.innerHTML = renderHexHTML(hex, hiStart, hiEnd);

    const decEl = $('decodeTree');
    if (decEl) {
      decEl.innerHTML = '';
      const raw = out.decoded || data.decoded;
      const decoded = (raw && typeof raw === 'object') ? raw : decodeHexBasic(hex);
      if (decoded && typeof decoded === 'object') {
        buildDecodeTreeDOM(decEl, decoded);
      } else if (typeof raw === 'string') {
        decEl.textContent = raw;
      } else {
        decEl.textContent = 'No decode.';
      }
    }
  } catch (err) { toast(`Build failed: ${err.message}`, 'bad'); }
}

async function sendFrame() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) { toast('Select a packet first', 'warn'); return; }
  const iface = pkt.interface || '';
  if (!iface) { toast('Select a sender interface first', 'warn'); return; }
  try {
    const p = buildPacketPayload(pkt);
    const data = await api('/api/send', { method:'POST', body: JSON.stringify(p) });
    const out = data.stdout || data;
    toast(`Sent ${out.framesSent || 1} frame(s), ${out.bytesSent || '?'} bytes`, 'ok');
    pkt.status = 'Sent'; renderPacketList();
    if ($('startTime')) $('startTime').textContent = new Date().toLocaleTimeString();
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}

let _pgListRunning = false;
let _pgSelRunning  = false;
let _pgAbort       = false;

async function sendSelectedPackets() {
  if (_pgSelRunning) { _pgAbort = true; return; }
  const sel = getActivePackets().filter(p => p.checked);
  if (!sel.length) { toast('Check at least one packet', 'warn'); return; }
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const repeat   = $('pgRepeat')?.checked || false;

  _pgSelRunning = true; _pgAbort = false;
  const selBtn = $('pgSendSelected');
  if (selBtn) { selBtn.textContent = '■ Stop'; selBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; }
  const sp = $('pgSelSpinner'), stats = $('pgStats');
  const t0 = new Date();
  if (sp) sp.style.display = '';

  let totalSent = 0, totalAttempts = 0, cycle = 0;
  do {
    cycle++;
    if (stats) stats.textContent = `시작: ${t0.toLocaleTimeString()} | 종료: — | 주기: ${cycle} | 전송 중…`;
    for (let i = 0; i < sel.length; i++) {
      if (_pgAbort) break;
      const pkt = sel[i];
      if (!pkt.interface) { pkt.status = 'ERR'; toast(`Packet "${pkt.name}": 인터페이스 미설정`, 'bad'); renderPacketList(); continue; }
      try {
        pkt.status = 'Running'; renderPacketList();
        await api('/api/send', { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
        pkt.status = 'Sent'; totalSent++;
      } catch (err) { pkt.status = 'ERR'; toast(`Send failed: ${err.message}`, 'bad'); }
      totalAttempts++;
      renderPacketList();
      if (periodMs > 0 && !_pgAbort) await new Promise(r => setTimeout(r, periodMs));
    }
    if (_pgAbort) break;
  } while (repeat && !_pgAbort);

  _pgSelRunning = false; _pgAbort = false;
  if (selBtn) { selBtn.textContent = '▶ Send Selected'; selBtn.style.cssText = ''; }
  if (sp) sp.style.display = 'none';
  const t1 = new Date();
  if (stats) stats.textContent = `시작: ${t0.toLocaleTimeString()} | 종료: ${t1.toLocaleTimeString()} | 주기: ${cycle} | 전송: ${totalSent}/${totalAttempts}개`;
  toast(`Send Selected: ${totalSent}/${totalAttempts} 완료`, totalSent === totalAttempts ? 'ok' : 'warn');
}

async function sendPacketList() {
  if (_pgListRunning) { _pgAbort = true; return; }
  const activePkts = getActivePackets();
  if (!activePkts.length) { toast('No packets in list', 'warn'); return; }
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const repeat   = $('pgRepeat')?.checked || false;

  _pgListRunning = true; _pgAbort = false;
  const listBtn = $('pgSendList');
  if (listBtn) { listBtn.textContent = '■ Stop'; listBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; }
  const sp = $('pgListSpinner'), stats = $('pgStats');
  const t0 = new Date();
  if (sp) sp.style.display = '';

  let totalSent = 0, totalAttempts = 0, cycle = 0;
  do {
    cycle++;
    if (stats) stats.textContent = `시작: ${t0.toLocaleTimeString()} | 종료: — | 주기: ${cycle} | 전송 중…`;
    for (let i = 0; i < activePkts.length; i++) {
      if (_pgAbort) break;
      const pkt = activePkts[i];
      if (!pkt.interface) { pkt.status = 'ERR'; toast(`Packet "${pkt.name}": 인터페이스 미설정`, 'bad'); renderPacketList(); continue; }
      try {
        pkt.status = 'Running'; renderPacketList();
        await api('/api/send', { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
        pkt.status = 'Sent'; totalSent++;
      } catch (err) { pkt.status = 'ERR'; toast(`Send failed: ${err.message}`, 'bad'); }
      totalAttempts++;
      renderPacketList();
      if (periodMs > 0 && !_pgAbort) await new Promise(r => setTimeout(r, periodMs));
    }
    if (_pgAbort) break;
  } while (repeat && !_pgAbort);

  _pgListRunning = false; _pgAbort = false;
  if (listBtn) { listBtn.textContent = '▶▶ Send List'; listBtn.style.cssText = ''; }
  if (sp) sp.style.display = 'none';
  const t1 = new Date();
  if (stats) stats.textContent = `시작: ${t0.toLocaleTimeString()} | 종료: ${t1.toLocaleTimeString()} | 주기: ${cycle} | 전송: ${totalSent}/${totalAttempts}개`;
  toast(`Send List: ${totalSent}/${totalAttempts} 완료`, 'ok');
}

// ── TC Import (Packet Generator) ─────────────────────────────────────────────

const ETHERTYPE_NAMES = { '0x0806':'ARP', '0x0800':'IPv4', '0x86dd':'IPv6', '0x8100':'VLAN' };
const ETHERTYPE_FROM_NAME = { 'ARP':'0x0806', 'IPv4':'0x0800', 'IP':'0x0800', 'IPv6':'0x86DD', 'VLAN':'0x8100' };

function normEtherType(v) {
  if (!v) return '0x0800';
  return ETHERTYPE_FROM_NAME[v.toUpperCase().trim()] || v;
}

function getActivePackets() {
  return state.activeList === 'tc' ? state.tcPackets : state.packets;
}

function setActivePackets(list) {
  if (state.activeList === 'tc') state.tcPackets = list;
  else state.packets = list;
}

let _tcDropOpen = false;
// Session-level packet cache: filePath → { tcPackets, tcOriginalRefs, tcNextFrameRef }
const _tcSessionCache = new Map();

function updateTcUI() {
  const closeBtn = $('pgTcClose');
  const tcBtn    = $('pgTcBtn');
  const isTc = state.activeList === 'tc';
  if (closeBtn) closeBtn.style.display = isTc ? '' : 'none';
  if (tcBtn) {
    const name = state.tcActivePath ? state.tcActivePath.split('/').pop().replace(/\.csv$/i,'') : '';
    tcBtn.textContent = _tcDropOpen ? 'TC 선택 ▴' : (isTc ? `TC 선택: ${name} ▾` : 'TC 선택 ▾');
  }
  // In TC mode: disable PG-tab packet management buttons (managed via Scenario Lab)
  ['pgAddPacket','pgDelPacket','pgDupPacket','pgUpPacket','pgDownPacket'].forEach(id => {
    const btn = $(id);
    if (btn) { btn.disabled = isTc; btn.style.opacity = isTc ? '.4' : ''; }
  });
}


async function toggleTcDropdown() {
  _tcDropOpen = !_tcDropOpen;
  const dd = $('pgTcDropdown');
  if (!dd) return;
  if (_tcDropOpen) {
    dd.style.display = '';
    positionTcDropdown();
    await renderTcDropdown();
  } else {
    dd.style.display = 'none';
  }
  updateTcUI();
}

function closeTcDropdown() {
  _tcDropOpen = false;
  const dd = $('pgTcDropdown'); if (dd) dd.style.display = 'none';
  updateTcUI();
}

function positionTcDropdown() {
  const btn = $('pgTcBtn'), dd = $('pgTcDropdown');
  if (!btn || !dd) return;
  const r = btn.getBoundingClientRect();
  dd.style.top  = `${r.bottom + 3}px`;
  dd.style.left = `${r.left}px`;
}

// Packet CSV paths collected at dropdown-open time (for nearest-match lookup)
let _knownPacketCsvPaths = [];

async function renderTcDropdown() {
  const dd = $('pgTcDropdown');
  if (!dd) return;
  dd.innerHTML = '<div class="tc-dd-loading">Loading…</div>';
  try {
    const data = await api('/api/testcases/csv-tree');

    // Collect packet CSV paths (TC_Packets.csv files) for later lookup
    _knownPacketCsvPaths = [];
    function collectPaths(nodes) {
      for (const n of (nodes || [])) {
        if (n.type === 'file' && n.isPacket) _knownPacketCsvPaths.push(n.path);
        else if (n.type === 'dir') collectPaths(n.children);
      }
    }
    collectPaths(data.tree || []);

    // Collect non-packet (scenario) CSVs with folder label
    function collectScenarioFiles(nodes, folderLabel) {
      const items = [];
      for (const n of (nodes || [])) {
        if (n.type === 'file' && !n.isPacket) {
          items.push({ ...n, folderLabel });
        } else if (n.type === 'dir') {
          const sub = folderLabel ? `${folderLabel}/${n.name}` : n.name;
          items.push(...collectScenarioFiles(n.children, sub));
        }
      }
      return items;
    }

    const scenarioFiles = collectScenarioFiles(data.tree || [], '');
    if (!scenarioFiles.length) { dd.innerHTML = '<div class="tc-dd-loading">No TC files found.</div>'; return; }

    // Group by folder
    const byFolder = new Map();
    for (const f of scenarioFiles) {
      const key = f.folderLabel || '';
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(f);
    }

    let html = '';
    for (const [folder, files] of byFolder) {
      if (folder) html += `<div class="tc-dd-group"><span class="tc-dd-icon">📁</span>${esc(folder)}</div>`;
      for (const f of files) {
        const active = state.tcActivePath === f.path;
        const indent = folder ? 'padding-left:26px;' : '';
        html += `<div class="tc-dd-item${active?' active':''}" data-path="${esc(f.path)}" style="${indent}">
          <span class="tc-dd-icon">📄</span><span>${esc(f.name)}</span>
          ${active ? '<span class="tc-dd-check">✓</span>' : ''}
        </div>`;
      }
    }

    dd.innerHTML = html;
    dd.querySelectorAll('.tc-dd-item').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedSeqTcIdx = -1;
        selectTcCsv(el.dataset.path);
      });
    });
  } catch (err) {
    dd.innerHTML = `<div class="tc-dd-loading" style="color:var(--red);">Error: ${esc(err.message)}</div>`;
  }
}

// Find the nearest TC_Packets.csv by walking up the directory of filePath
function findNearestPacketCsv(filePath) {
  const dirParts = filePath.split('/').slice(0, -1);
  for (let i = dirParts.length; i >= 0; i--) {
    const prefix = dirParts.slice(0, i).join('/');
    const match = _knownPacketCsvPaths.find(p => {
      const pDir = p.split('/').slice(0, -1).join('/');
      return pDir === prefix;
    });
    if (match) return match;
  }
  return null;
}

function parseTcCsvToPackets(rows, frameRefToIdx) {
  const map = new Map();
  for (const row of rows) {
    const ref = row['FrameRef'] || '';
    if (!ref) continue;
    if (!map.has(ref)) map.set(ref, { name: ref, dstMac: '', srcMac: '', etherType: '0x0800', rawHex: '' });
    const g     = map.get(ref);
    const proto = (row['Protocol'] || '').toUpperCase();
    const field = row['Field'] || '';
    const value = (row['Value'] || '').trim();
    if (proto === 'ETH') {
      if (field === 'Destination MAC') g.dstMac = value;
      else if (field === 'Source MAC')  g.srcMac = value;
      else if (field === 'EtherType')   g.etherType = normEtherType(value);
    } else if (proto === 'RAW') {
      g.rawHex = value.replace(/^0x/i, '');
    }
  }
  return [...map.values()].map((g, i) => {
    // Use scenario CSV Index column value if available, else fall back to FrameRef suffix
    let originalOrder;
    if (frameRefToIdx && frameRefToIdx.has(g.name)) {
      originalOrder = frameRefToIdx.get(g.name);
    } else {
      const m = g.name.match(/(\d+)$/);
      originalOrder = m ? parseInt(m[1], 10) : i;
    }
    return {
      id:           Date.now() + Math.random() + i,
      name:         g.name,
      originalOrder,
      blocks:    [
        { type:'Ethernet', dstMac: g.dstMac||'FF:FF:FF:FF:FF:FF', srcMac: g.srcMac||'00:00:00:00:00:00', etherType: g.etherType },
        ...(g.rawHex ? [{ type:'Payload', mode:'hex', data: g.rawHex }] : []),
      ],
      status:    '',
      checked:   false,
      interface: '',
    };
  });
}

// Persist current TC's sequence + packet state into session cache.
function _saveTcToSessionCache() {
  if (state.activeList === 'tc' && state.tcActivePath) {
    _tcSessionCache.set(state.tcActivePath, {
      seqRows:          [...state.seqItems],
      seqHeaders:       [...state.seqItemHeaders],
      seqOriginalItems: [...state.seqOriginalItems],
      tcPackets:        [...state.tcPackets],
      tcOriginalRefs:   new Set(state.tcOriginalRefs),
      tcNextFrameRef:   state.tcNextFrameRef,
    });
  }
}

async function selectTcCsv(filePath) {
  if (state.tcActivePath === filePath && state.activeList === 'tc') return;

  closeTcDropdown();

  // Save current TC state before switching
  _saveTcToSessionCache();

  // Cache hit: restore everything from session memory
  if (_tcSessionCache.has(filePath)) {
    const c = _tcSessionCache.get(filePath);
    state.seqItems          = c.seqRows;
    state.seqItemHeaders    = c.seqHeaders;
    state.seqOriginalItems  = c.seqOriginalItems ? [...c.seqOriginalItems] : [];
    state.tcPackets         = c.tcPackets;
    state.tcOriginalRefs    = c.tcOriginalRefs;
    state.tcNextFrameRef    = c.tcNextFrameRef;
    state.tcActivePath      = filePath;
    state.activeList        = 'tc';
    state.selectedSeqTcIdx  = -1;
    state.selectedSeqRowIdx = -1;
    const name = filePath.split('/').pop().replace(/\.csv$/i, '');
    const titleEl = $('scDetailTitle');
    if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
    renderCsvSequence(state.seqItems);
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    toast(`TC: ${name} — ${state.tcPackets.length}개 패킷 (세션)`, 'ok');
    return;
  }

  // Cache miss: first visit — load from disk
  try {
    const tcData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(filePath)}`);
    const tcRows = tcData.rows || [];
    const frameRefs = new Set(
      tcRows
        .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
        .map(r => (r['FrameRef'] || '').trim())
        .filter(r => r && r !== '-')
    );

    let tcPackets = [];
    const packetsCsvPath = findNearestPacketCsv(filePath);
    if (packetsCsvPath) {
      const pktsData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(packetsCsvPath)}`);
      const allRows = pktsData.rows || [];
      let maxLocalRef = -1;
      for (const ref of frameRefs) {
        const m = ref.match(/(\d+)$/);
        if (m) maxLocalRef = Math.max(maxLocalRef, parseInt(m[1], 10));
      }
      state.tcNextFrameRef = maxLocalRef + 1;
      tcPackets = frameRefs.size
        ? parseTcCsvToPackets(allRows.filter(r => frameRefs.has(r['FrameRef'])))
        : [];
    } else {
      state.tcNextFrameRef = 0;
    }

    state.tcPackets        = tcPackets;
    state.tcOriginalRefs   = new Set(frameRefs);
    state.seqItems         = tcRows;
    state.seqOriginalItems = tcRows.map(r => ({...r}));
    state.seqItemHeaders   = tcData.headers || [];
    state.seqItems.forEach((r, i) => { if (!r['Index']) r['Index'] = String(i + 1); });
    renderCsvSequence(state.seqItems);   // C# LoadSequence에 해당 — 시퀀스 패널 갱신
    state.tcActivePath     = filePath;
    state.activeList       = 'tc';
    state.selectedSeqTcIdx = -1;
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    const name = filePath.split('/').pop().replace(/\.csv$/i, '');
    toast(`TC: ${name} — ${tcPackets.length}개 패킷 로드`, 'ok');
  } catch (err) { toast(`TC load failed: ${err.message}`, 'bad'); }
}

// Load TC packets for a given filePath+tcRows without touching state.seqItems.
// Used by selectSeqTc() so the PG tab shows the TC's packets.
async function _activateTcPackets(filePath, tcRows) {
  if (state.tcActivePath === filePath && state.activeList === 'tc') {
    // Already active — just sync and refresh PG list
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    return;
  }
  try {
    if (_tcSessionCache.has(filePath)) {
      const c = _tcSessionCache.get(filePath);
      state.tcPackets      = c.tcPackets;
      state.tcOriginalRefs = c.tcOriginalRefs;
      state.tcNextFrameRef = c.tcNextFrameRef;
    } else {
      const frameRefs = new Set(
        (tcRows || [])
          .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
          .map(r => (r['FrameRef'] || '').trim())
          .filter(r => r && r !== '-')
      );
      let tcPackets = [];
      const packetsCsvPath = findNearestPacketCsv(filePath);
      if (packetsCsvPath) {
        const pktsData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(packetsCsvPath)}`);
        const allRows = pktsData.rows || [];
        let maxLocalRef = -1;
        for (const ref of frameRefs) {
          const m = ref.match(/(\d+)$/);
          if (m) maxLocalRef = Math.max(maxLocalRef, parseInt(m[1], 10));
        }
        state.tcNextFrameRef = maxLocalRef + 1;
        tcPackets = frameRefs.size
          ? parseTcCsvToPackets(allRows.filter(r => frameRefs.has(r['FrameRef'])))
          : [];
      } else {
        state.tcNextFrameRef = 0;
        tcPackets = [];
      }
      state.tcPackets      = tcPackets;
      state.tcOriginalRefs = new Set(frameRefs);
      state.seqItems       = tcRows || [];
      state.seqItemHeaders = [];
      state.seqItems.forEach((r, i) => { if (!r['Index']) r['Index'] = String(i + 1); });
    }
    state.tcActivePath = filePath;
    state.activeList   = 'tc';
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
  } catch (err) { toast(`TC 패킷 로드 실패: ${err.message}`, 'bad'); }
}

function clearTcMode() {
  _tcSessionCache.clear();

  // Revert all tcSeqList entries to their original CSV rows
  for (const tc of state.tcSeqList) {
    if (tc.originalRows) tc.rows = tc.originalRows.map(r => ({...r}));
  }
  // Re-render the currently selected sequence panel
  if (state.selectedSeqTcIdx >= 0) {
    const tc = state.tcSeqList[state.selectedSeqTcIdx];
    if (tc) renderCsvSequence(tc.rows);
  }

  // Revert seqItems (used when TC was loaded via PG dropdown, not tcSeqList)
  if (state.seqOriginalItems && state.seqOriginalItems.length) {
    state.seqItems = state.seqOriginalItems.map(r => ({...r}));
    state.seqOriginalItems = [];
    if (state.selectedSeqTcIdx < 0) renderCsvSequence(state.seqItems);
  }

  state.tcPackets        = [];
  state.tcActivePath     = '';
  state.tcOriginalRefs   = new Set();
  state.selectedSeqTcIdx = -1;
  state.activeList       = 'pg';
  closeTcDropdown();
  updateTcUI();
  selectPacket(-1);
  updateEstimatedTime();
  toast('TC 종료 — Packet Generator 리스트 복귀', 'ok');
}

// ── Capture ───────────────────────────────────────────────────────────────────
function formatCaptureRow(r) {
  const eth  = r.decoded?.ethernet || r.decoded?.eth || {};
  const ip   = r.decoded?.ipv4 || {};
  const udp  = r.decoded?.udp || {};
  const tcp  = r.decoded?.tcp || {};
  const icmp = r.decoded?.icmp || {};
  const arp  = r.decoded?.arp || {};

  let protocol = 'RAW';
  if      (udp.srcPort  !== undefined) protocol = 'UDP';
  else if (tcp.srcPort  !== undefined) protocol = 'TCP';
  else if (icmp.type    !== undefined) protocol = 'ICMP';
  else if (arp.operation !== undefined) protocol = 'ARP';
  else if (ip.src)                     protocol = 'IPv4';

  let source = ip.src  || eth.srcMac || '';
  let dest   = ip.dst  || eth.dstMac || '';
  if (udp.srcPort  !== undefined) { source += `:${udp.srcPort}`;  dest += `:${udp.dstPort}`; }
  else if (tcp.srcPort !== undefined) { source += `:${tcp.srcPort}`; dest += `:${tcp.dstPort}`; }

  let info = '';
  if (udp.srcPort !== undefined)        info = `${udp.srcPort} → ${udp.dstPort}  Len=${r.length}`;
  else if (tcp.srcPort !== undefined)   info = `${tcp.srcPort} → ${tcp.dstPort}`;
  else if (icmp.type !== undefined)     info = `Type=${icmp.type} Code=${icmp.code || 0}`;
  else if (arp.operation !== undefined) info = arp.operation === 1 ? `Who has ${arp.targetIp}? Tell ${arp.senderIp}` : `${arp.senderIp} is at ${arp.senderMac}`;
  else if (eth.etherType)               info = `EtherType=0x${Number(eth.etherType).toString(16).toUpperCase().padStart(4,'0')}`;

  const d = new Date((r.timestamp || 0) * 1000);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;

  return {
    no: r.no, time,
    interfaceName: r.interface || r.interfaceName || '',
    srcMac: eth.srcMac || '',
    dstMac: eth.dstMac || '',
    source, destination: dest, protocol, length: r.length, info,
    detailText: JSON.stringify(r.decoded || {}, null, 2),
    hexDump: formatHex(r.frameHex || r.hex || ''),
  };
}

async function refreshCaptureStatus() {
  try {
    const data = await api('/api/capture/status');
    const running = data.running || data.capturing || false;
    const total = data.totalPackets || data.captureCount || 0;
    [$('captureRunning'), $('captureRunning2')].forEach(el => { if (el) el.textContent = running ? '● capturing' : 'idle'; });
    [$('captureTotal'), $('captureTotal2')].forEach(el => { if (el) el.textContent = `${total} pkts`; });

    const list = $('captureInterfaces');
    if (!list) return;
    list.innerHTML = '';
    state.captureInterfaces = new Set((data.interfaces || []).filter(i => i.selected).map(i => i.name));
    for (const iface of data.interfaces || []) {
      const label = document.createElement('label');
      label.className = 'check-row';
      label.innerHTML = `<input type="checkbox" name="capture-iface" ${iface.selected ? 'checked' : ''} value="${esc(iface.name)}">
        <span><strong>${esc(iface.name)}</strong><small>${esc(iface.description || iface.state || '')}</small></span>`;
      label.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) state.captureInterfaces.add(iface.name);
        else state.captureInterfaces.delete(iface.name);
      });
      list.appendChild(label);
    }
  } catch { /* keep stable */ }
}

async function startCapture() {
  try {
    await api('/api/capture/start', { method: 'POST', body: JSON.stringify({ interfaces: [...state.captureInterfaces] }) });
    toast('Capture started', 'ok');
    startCapturePolling();
    await refreshCaptureStatus();
  } catch (err) { toast(`Capture failed: ${err.message}`, 'bad'); }
}

async function stopCapture() {
  try {
    await api('/api/capture/stop', { method: 'POST', body: '{}' });
    toast('Capture stopped', 'ok');
    await refreshCaptureStatus();
  } catch (err) { toast(`Stop failed: ${err.message}`, 'bad'); }
}

async function clearCapture() {
  try {
    await api('/api/capture/clear', { method: 'POST', body: '{}' });
    state.captureRows = [];
    renderCaptureRows();
    if ($('packetDetails')) $('packetDetails').textContent = 'Select a packet.';
    if ($('packetHex'))     $('packetHex').textContent = '';
    await refreshCaptureStatus();
  } catch { /* ignore */ }
}

function startCapturePolling() {
  if (state.captureTimer) clearInterval(state.captureTimer);
  state.captureTimer = setInterval(loadCapturePackets, 900);
  loadCapturePackets();
}

async function loadCapturePackets() {
  try {
    const data = await api('/api/capture/packets?limit=1000');
    state.captureRows = (data.rows || []).map(formatCaptureRow);
    renderCaptureRows();
    updateCaptureProtoSummary();
    const total = data.total || state.captureRows.length;
    [$('captureTotal'), $('captureTotal2')].forEach(el => { if (el) el.textContent = `${total} pkts`; });
    updateStatusBar();
  } catch { /* keep stable */ }
}

function updateCaptureProtoSummary() {
  const c = { ARP:0, IPv4:0, IPv6:0, TCP:0, UDP:0, ICMP:0 };
  for (const r of state.captureRows) {
    const p = (r.protocol || '').toUpperCase();
    if (p === 'ARP')  c.ARP++;
    else if (p === 'IPV4' || p === 'IPv4') c.IPv4++;
    else if (p === 'IPV6' || p === 'IPv6') c.IPv6++;
    else if (p === 'TCP')  c.TCP++;
    else if (p === 'UDP')  c.UDP++;
    else if (p === 'ICMP') c.ICMP++;
  }
  if ($('capCntArp'))  $('capCntArp').textContent  = c.ARP;
  if ($('capCntIpv4')) $('capCntIpv4').textContent = c.IPv4;
  if ($('capCntIpv6')) $('capCntIpv6').textContent = c.IPv6;
  if ($('capCntTcp'))  $('capCntTcp').textContent  = c.TCP;
  if ($('capCntUdp'))  $('capCntUdp').textContent  = c.UDP;
  if ($('capCntIcmp')) $('capCntIcmp').textContent = c.ICMP;
}

function rowMatchesFilter(row, filter) {
  if (!filter) return true;
  const text = `${row.no} ${row.time} ${row.interfaceName} ${row.source} ${row.destination} ${row.protocol} ${row.length} ${row.info} ${row.srcMac} ${row.dstMac}`.toLowerCase();
  return filter.split(/\s+/).filter(Boolean).every(tok => {
    if (tok.startsWith('mac:'))  return `${row.srcMac} ${row.dstMac}`.toLowerCase().includes(tok.slice(4));
    if (tok.startsWith('ip:'))   return `${row.source} ${row.destination}`.toLowerCase().includes(tok.slice(3));
    if (tok.startsWith('port:')) return `${row.source} ${row.destination} ${row.info}`.toLowerCase().includes(tok.slice(5));
    return text.includes(tok);
  });
}

function renderCaptureRows() {
  const tbody = $('captureRows');
  if (!tbody) return;
  const filter = ($('captureFilter')?.value || '').trim().toLowerCase();
  const rows = state.captureRows.filter(r => rowMatchesFilter(r, filter));
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty">No packets captured.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r, i) => `
    <tr data-idx="${i}" class="proto-${esc((r.protocol||'').toLowerCase())}">
      <td>${r.no}</td><td>${esc(r.time)}</td><td>${esc(r.interfaceName)}</td>
      <td>${esc(r.srcMac)}</td><td>${esc(r.dstMac)}</td>
      <td>${esc(r.source)}</td><td>${esc(r.destination)}</td>
      <td><strong>${esc(r.protocol)}</strong></td>
      <td>${r.length}</td><td>${esc(r.info)}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      const row = rows[Number(tr.dataset.idx)];
      if ($('packetDetails')) $('packetDetails').textContent = row.detailText || 'No detail.';
      if ($('packetHex'))     $('packetHex').textContent = row.hexDump || '';
    });
  });
}

function downloadCaptureCsv() {
  // Try server export first, fall back to client-side
  window.open('/api/capture/export-csv', '_blank');
}

// ── Scenario Lab ──────────────────────────────────────────────────────────────
async function loadTestCases() {
  try {
    const data = await api('/api/testcases/status');
    const snapshot = data.snapshot || data.testCases || [];
    const allGroups = Array.isArray(snapshot) ? snapshot : (snapshot.groups || []);
    // Filter out legacy isPacketDef groups, root-folder groups, and synthetic __sequence__ entry
    const groups = allGroups.filter(g => !g.isPacketDef && g.name !== '(root)' && g.id !== '__sequence__' && g.name !== '__sequence__');
    const hasRealCases = groups.some(g => (g.cases || []).length > 0);
    if (!hasRealCases) {
      // Auto-import CSV files if no test cases exist yet
      const scan = await api('/api/testcases/scan-scenarios').catch(() => null);
      if (scan?.files?.length) {
        await api('/api/testcases/import-all-csv', { method: 'POST', body: '{}' }).catch(() => null);
        const d2 = await api('/api/testcases/status');
        const g2 = d2.snapshot || [];
        const groups2 = (Array.isArray(g2) ? g2 : (g2.groups || [])).filter(g => !g.isPacketDef && g.name !== '(root)');
        renderTcTree(groups2);
        return;
      }
    }
    renderTcTree(groups);
  } catch { /* ignore */ }
}

async function loadSequence() {
  try {
    const data = await api('/api/sequence/full');
    const items = data.items || [];
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence (${items.length} events)`;
    renderSequenceRows(items);
  } catch { renderSequenceRows([]); }
}

function renderTcTree(groups) {
  state.tcGroups = groups;
  const root = $('tcTree');
  if (!root) return;
  if (!groups.length) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;">No groups. Import CSV or add one.</p>'; return; }
  root.innerHTML = groups.map((g, gi) => `
    <div class="tc-group">
      <div class="tc-group-head">
        <span>${esc(g.name)}</span>
        <button class="small danger tc-del-group" data-group="${gi}">Del</button>
      </div>
      ${(g.cases || g.testCases || []).map((t, ti) => `
        <div class="tc-item" data-group="${gi}" data-tc="${ti}">
          <input type="checkbox" name="tc-check" class="tc-check" data-group="${gi}" data-tc="${ti}">
          <span class="tc-item-name">${esc(t.name)}</span><small>${(t.steps||[]).length} steps</small>
        </div>`).join('')}
    </div>`).join('');
  root.querySelectorAll('.tc-item').forEach(el => el.addEventListener('click', async e => {
    if (e.target.type === 'checkbox') return;
    const gi = Number(el.dataset.group), ti = Number(el.dataset.tc);
    root.querySelectorAll('.tc-item').forEach(e2 => e2.classList.remove('selected'));
    el.classList.add('selected');
    const grp = state.tcGroups[gi];
    const tc  = grp && (grp.cases || grp.testCases || [])[ti];
    if (!tc) return;
    // Re-enable action buttons
    ['seqRun', 'scSendSelected', 'scSendList'].forEach(id => {
      const btn = $(id); if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
    // C# SelectTc: 시퀀스 패널 즉시 표시 후 비동기 로드
    renderCsvSequence(tc.steps || []);
    if (tc.path) {
      state.selectedSeqTcIdx = -1;
      selectTcCsv(tc.path).catch(() => {});
    }
  }));
  root.querySelectorAll('.tc-del-group').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Delete this group?')) return;
    await api('/api/testcases/delete', { method: 'POST', body: JSON.stringify({ groupIndex: Number(btn.dataset.group) }) });
    await loadTestCases();
  }));
}


function seqEventSummary(item) {
  const t = (item.eventType || item.type || '').toLowerCase();
  if (t === 'delay')           return `${item.delayMs ?? 100}ms`;
  if (t === 'registerwrite')   return `${item.offset || item.address}  ←  ${item.value}`;
  if (t === 'registerread')    return `${item.offset || item.address}`;
  if (t === 'registerexpect')  return `${item.offset || item.address} & ${item.mask||'0xFFFFFFFF'} == ${item.expected} [${item.timeoutMs||1000}ms]`;
  if (t === 'fdbwrite')        return `MAC:${item.mac}  Port:${item.port}`;
  if (t === 'fdbwritebucket')  return `MAC:${item.mac}  Bucket:${item.bucket}  Slot:${item.slot}`;
  if (t === 'fdbread')         return `MAC:${item.mac}`;
  if (t === 'fdbreadbucket')   return `Bucket:${item.bucket}  Slot:${item.slot}`;
  if (t === 'fdbwaitfor')      return `MAC:${item.mac}  timeout:${item.timeoutMs}ms`;
  if (t === 'fdbinitialize')   return 'flush all';
  if (t === 'rxverify')        return `if:${item.captureInterface||'?'}  filter:${item.captureFilter||''}  expect:${item.captureExpected||1}`;
  return JSON.stringify(item).slice(0,60);
}

function getEventKind(item) {
  const t = (item.eventType || item.type || item.kind || '').toLowerCase();
  if (t.startsWith('fdb')) return 'FDB';
  if (t.includes('register')) return 'Reg';
  if (t === 'delay') return 'Delay';
  if (t.includes('verify') || t.includes('rx')) return 'Verify';
  return 'Event';
}

function renderSequenceRows(items) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  state.seqItems = items || [];
  if (!items || !items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No sequence. Select a TC and press ›.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((item, i) => {
    const evType  = item.eventType || item.type || item.kind || '';
    const name    = item.name || '';
    const mac     = item.mac || '';
    const details = seqEventSummary(item);
    const timeout = item.delayMs ? `${item.delayMs}ms` : (item.timeoutMs ? `${item.timeoutMs}ms` : '');
    return `<tr data-idx="${i}" draggable="true">
      <td style="color:var(--muted);">${i+1}</td>
      <td>${esc(name)}</td>
      <td><span class="ev-badge ev-${esc(evType.toLowerCase())}">${esc(evType)}</span></td>
      <td class="mono" style="font-size:10px;">${esc(mac)}</td>
      <td style="color:var(--muted);font-size:10px;">${esc(details)}</td>
      <td style="color:var(--muted);">${esc(timeout)}</td>
      <td style="font-size:10px;">${esc(item.status || '')}</td>
    </tr>`;
  }).join('');
}

// TC Sequence (bottom panel)
function tcSeqAddChecked() {
  const checked = document.querySelectorAll('.tc-check:checked');
  if (!checked.length) { toast('Check at least one TC', 'warn'); return; }
  checked.forEach(chk => {
    const gi = Number(chk.dataset.group), ti = Number(chk.dataset.tc);
    const grp = state.tcGroups[gi];
    const tc  = (grp?.cases || grp?.testCases || [])[ti];
    if (tc) state.tcSeqList.push({ ...tc, _gi:gi, _ti:ti, status:'Queued' });
  });
  renderTcSeqRows();
  toast(`${checked.length} TC(s) added to sequence`, 'ok');
}

function tcSeqRemoveSelected() {
  if (state.selectedTcSeqIdx < 0) { toast('Select a TC first','warn'); return; }
  state.tcSeqList.splice(state.selectedTcSeqIdx, 1);
  state.selectedTcSeqIdx = Math.min(state.selectedTcSeqIdx, state.tcSeqList.length - 1);
  renderTcSeqRows();
}

function tcSeqClearAll() {
  if (!state.tcSeqList.length) return;
  if (!confirm('Clear all queued TCs?')) return;
  state.tcSeqList = []; state.selectedTcSeqIdx = -1; renderTcSeqRows();
}

function renderTcSeqRows() {
  const tbody = $('tcSeqRows');
  if (!tbody) return;
  if (!state.tcSeqList.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No TC queued.</td></tr>'; return; }
  tbody.innerHTML = state.tcSeqList.map((tc, i) => `
    <tr class="${i === state.selectedTcSeqIdx ? 'selected' : ''}">
      <td>${i+1}</td>
      <td>${esc(tc.name || '')}</td>
      <td>${(tc.steps || []).length}</td>
      <td style="font-size:10px;">${esc(tc.status || 'Queued')}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => {
      state.selectedTcSeqIdx = i; renderTcSeqRows();
      const tc = state.tcSeqList[i]; if (tc) renderSequenceRows(tc.steps || []);
    });
  });
}

async function addTcGroup() {
  const name = prompt('Group name:');
  if (!name?.trim()) return;
  await api('/api/testcases/add-group', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
  await loadTestCases();
}

async function saveTcCurrent() {
  try {
    await api('/api/testcases/save-current', { method: 'POST', body: '{}' });
    toast('Saved', 'ok');
    await loadTestCases();
  } catch (err) { toast(`Save failed: ${err.message}`, 'bad'); }
}

async function importCsvScenarios() {
  const btn = $('tcImportCsv');
  if (btn) btn.disabled = true;
  try {
    const scan = await api('/api/testcases/scan-scenarios');
    if (!scan.files?.length) { toast('No CSV files found in testScenarios/', 'bad'); return; }
    const res = await api('/api/testcases/import-all-csv', { method: 'POST', body: '{}' });
    toast(`Imported ${res.imported ?? 0} CSV file(s)`, 'ok');
    await loadTestCases();
  } catch (err) { toast(`CSV import failed: ${err.message}`, 'bad'); }
  finally { if (btn) btn.disabled = false; }
}

// ── Event Palette (inline editor in sidebar) ──────────────────────────────────
const EVENT_FIELDS = {
  Delay:          [{ id:'delayMs',          label:'Delay (ms)',      type:'number', def:'500' }],
  RegWrite:       [{ id:'offset',           label:'Offset (hex)',    type:'text',   def:'0x000' },
                   { id:'value',            label:'Value (hex)',     type:'text',   def:'0x00000001' }],
  RegRead:        [{ id:'offset',           label:'Offset (hex)',    type:'text',   def:'0x000' }],
  RegVerify:      [{ id:'offset',           label:'Offset (hex)',    type:'text',   def:'0x000' },
                   { id:'expected',         label:'Expected (hex)',  type:'text',   def:'0x00000001' },
                   { id:'mask',             label:'Mask (hex)',      type:'text',   def:'0xFFFFFFFF' },
                   { id:'timeoutMs',        label:'Timeout (ms)',    type:'number', def:'1000' }],
  FdbWrite:       [{ id:'mac',              label:'MAC',             type:'text',   def:'00:00:00:00:00:00' },
                   { id:'vlanId',           label:'VLAN ID',         type:'number', def:'0' },
                   { id:'port',             label:'Port',            type:'number', def:'0' }],
  FdbWriteBucket: [{ id:'mac',              label:'MAC',             type:'text',   def:'00:00:00:00:00:00' },
                   { id:'vlanId',           label:'VLAN ID',         type:'number', def:'0' },
                   { id:'port',             label:'Port',            type:'number', def:'0' },
                   { id:'bucket',           label:'Bucket',          type:'number', def:'0' },
                   { id:'slot',             label:'Slot',            type:'number', def:'1' }],
  FdbRead:        [{ id:'mac',              label:'MAC',             type:'text',   def:'00:00:00:00:00:00' },
                   { id:'vlanId',           label:'VLAN ID',         type:'number', def:'0' }],
  FdbReadBucket:  [{ id:'bucket',           label:'Bucket',          type:'number', def:'0' },
                   { id:'slot',             label:'Slot',            type:'number', def:'1' }],
  FdbWaitFor:     [{ id:'mac',              label:'MAC',             type:'text',   def:'00:00:00:00:00:00' },
                   { id:'vlanId',           label:'VLAN ID',         type:'number', def:'0' },
                   { id:'timeoutMs',        label:'Timeout (ms)',    type:'number', def:'5000' }],
  FdbInitialize:  [],
  RxVerify:       [{ id:'captureInterface', label:'Interface',       type:'text',   def:'' },
                   { id:'captureFilter',    label:'Filter (text)',   type:'text',   def:'' },
                   { id:'captureExpected',  label:'Min frames',      type:'number', def:'1' }],
};

const EVENT_API_TYPE = {
  Delay:'delay', RegWrite:'registerWrite', RegRead:'registerRead', RegVerify:'registerExpect',
  FdbWrite:'fdbWrite', FdbWriteBucket:'fdbWriteBucket', FdbRead:'fdbRead', FdbReadBucket:'fdbReadBucket',
  FdbWaitFor:'fdbWaitFor', FdbInitialize:'fdbInitialize', RxVerify:'rxVerify',
};

function showEventEditor(kind) {
  document.querySelectorAll('.palette-item, .ev-add-btn').forEach(el => el.classList.toggle('active', el.dataset.event === kind));
  const titleEl = $('eventEditorTitle'), fieldsEl = $('eventEditorFields'), addBtn = $('addToSequence');
  if (!titleEl || !fieldsEl) return;
  titleEl.textContent = kind;
  const fields = EVENT_FIELDS[kind] || [];
  fieldsEl.innerHTML = fields.length
    ? fields.map(f => `<div class="field"><label>${esc(f.label)}</label><input id="eef-${f.id}" type="${f.type}" value="${esc(f.def)}" placeholder="${esc(f.label)}"></div>`).join('')
    : `<p style="font-size:11px;color:var(--muted);padding:0 0 4px;">No parameters required.</p>`;
  if (addBtn) { addBtn.disabled = false; addBtn.dataset.evKind = kind; }
}

async function addEventFromEditor() {
  const btn = $('addToSequence');
  const kind = btn?.dataset.evKind;
  if (!kind) return;
  const event = { eventType: EVENT_API_TYPE[kind] || kind.toLowerCase() };
  for (const f of EVENT_FIELDS[kind] || []) {
    const el = $(`eef-${f.id}`); if (!el) continue;
    event[f.id] = f.type === 'number' ? Number(el.value) : el.value;
  }
  try {
    await api('/api/sequence/event/add', { method:'POST', body: JSON.stringify(event) });
    await loadSequence();
    toast(`${kind} added`, 'ok');
  } catch (err) { toast(`Add failed: ${err.message}`, 'bad'); }
}

// ── Sequence Run/Stop/Reset ───────────────────────────────────────────────────
function resetSequence() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  state.tcSeqList.forEach(tc => { tc.status = 'Queued'; });
  renderTcSeqRows();
  renderSequenceRows([]);
  appendSeqTerm('↺ Sequence reset');
}

let _seqPollTimer = null;

async function runSequence() {
  try {
    await api('/api/sequence/run', { method:'POST', body:'{}' });
    appendSeqTerm('▶ Sequence started');
    toast('Sequence started', 'ok');
    let prevStatus = '';
    _seqPollTimer = setInterval(async () => {
      try {
        const s = await api('/api/auto/status');
        if (s.statusText && s.statusText !== prevStatus) { appendSeqTerm(s.statusText); prevStatus = s.statusText; }
        if (!s.running) {
          clearInterval(_seqPollTimer); _seqPollTimer = null;
          appendSeqTerm(`■ Done: ${s.result || 'COMPLETED'}`);
          try {
            const r = await api('/api/auto/results');
            (r.rows || []).forEach(row => appendSeqTerm(`  [${row.result}] Step ${row.step} — ${row.name}: ${row.detail || ''}`));
          } catch { /* ignore */ }
          toast(`Sequence ${s.result || 'done'}`, s.result === 'PASS' ? 'ok' : 'bad');
        }
      } catch { clearInterval(_seqPollTimer); _seqPollTimer = null; }
    }, 500);
  } catch (err) { toast(`Run failed: ${err.message}`, 'bad'); }
}

async function stopSequence() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  try {
    await api('/api/auto/stop', { method:'POST', body:'{}' });
    appendSeqTerm('■ Sequence stopped');
    toast('Stopped', 'ok');
  } catch (err) { toast(`Stop failed: ${err.message}`, 'bad'); }
}

async function clearSequence() {
  if (!confirm('Clear all sequence events?')) return;
  try {
    await api('/api/sequence/events/clear', { method:'POST', body:'{}' }).catch(() =>
      api('/api/sequence/clear', { method:'POST', body:'{}' }));
    await loadSequence();
    toast('Sequence cleared', 'ok');
  } catch (err) { toast(`Clear failed: ${err.message}`, 'bad'); }
}

// ── CSV-based Test Case tree ──────────────────────────────────────────────────
// ── CSV Upload ────────────────────────────────────────────────────────────────

let _uploadFiles = [];

function initCsvUpload() {
  const btn      = $('tcUploadBtn');
  const panel    = $('tcUploadPanel');
  const pickBtn  = $('tcUploadPickBtn');
  const doBtn    = $('tcUploadDoBtn');
  const fileInput= $('tcUploadFileInput');
  const fileList = $('tcUploadFileList');
  const folderSel= $('tcUploadFolder');
  if (!btn || !panel) return;

  btn.addEventListener('click', async () => {
    const open = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = open ? '' : 'none';
    if (open) {
      // Populate folder dropdown from current tree
      folderSel.innerHTML = '<option value="">(root) testScenarios/</option>';
      try {
        const data = await api('/api/testcases/csv-tree');
        function addFolderOpts(nodes, prefix) {
          for (const n of (nodes || [])) {
            if (n.type === 'dir') {
              const p = prefix ? `${prefix}/${n.name}` : n.name;
              folderSel.innerHTML += `<option value="${esc(p)}">${esc(p)}/</option>`;
              addFolderOpts(n.children, p);
            }
          }
        }
        addFolderOpts(data.tree || [], '');
      } catch {}
    }
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    _uploadFiles = Array.from(fileInput.files || []);
    fileList.innerHTML = _uploadFiles.map(f => `<span class="tc-upload-chip">${esc(f.name)}</span>`).join('');
    doBtn.disabled = _uploadFiles.length === 0;
    fileInput.value = '';
  });

  doBtn.addEventListener('click', async () => {
    if (!_uploadFiles.length) return;
    const folder = folderSel.value;
    doBtn.disabled = true;
    doBtn.textContent = '⏳ Uploading…';
    try {
      const fileObjs = await Promise.all(_uploadFiles.map(async f => ({
        name: f.name,
        content: await f.text(),
      })));
      const data = await api('/api/testcases/upload', {
        method: 'POST',
        body: JSON.stringify({ files: fileObjs, folder }),
      });
      const ok  = (data.results || []).filter(r => r.ok).length;
      const bad = (data.results || []).filter(r => !r.ok);
      if (ok) toast(`✓ ${ok}개 파일 업로드 완료`, 'ok');
      bad.forEach(r => toast(`✗ ${r.name}: ${r.error}`, 'bad'));
      _uploadFiles = [];
      fileList.innerHTML = '';
      doBtn.disabled = true;
      _csvTreeHash = '';
      loadCsvTree();
      if (!bad.length) panel.style.display = 'none';
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'bad');
    }
    doBtn.disabled = false;
    doBtn.textContent = '📤 업로드';
  });
}

let _csvTreeHash = '';
let _csvPollTimer = null;
let _lastCsvTreeData = null;

/** Flatten tree nodes into Map<relPath, mtime> for quick lookup. */
function flattenTreeMtimes(nodes, out) {
  out = out || new Map();
  for (const n of (nodes || [])) {
    if (n.type === 'file') out.set(n.path, n.mtime || 0);
    else if (n.type === 'dir') flattenTreeMtimes(n.children, out);
  }
  return out;
}

async function loadCsvTree() {
  try {
    const data = await api('/api/testcases/csv-tree');
    _lastCsvTreeData = data;
    // Always keep packet CSV paths up to date so findNearestPacketCsv works
    _knownPacketCsvPaths = [];
    (function collectPaths(nodes) {
      for (const n of (nodes || [])) {
        if (n.type === 'file' && n.isPacket) _knownPacketCsvPaths.push(n.path);
        else if (n.type === 'dir') collectPaths(n.children);
      }
    })(data.tree || []);
    const hash = JSON.stringify(data);
    const changed = hash !== _csvTreeHash;
    if (changed) {
      _csvTreeHash = hash;
      renderCsvTree(data);
    }
    // Always check sequence items for stale CSV content
    await _refreshStaleSeqItems(data);
  } catch {
    const root = $('csvTree');
    if (root && !root.innerHTML) root.innerHTML = '<p style="color:var(--muted);font-size:10px;padding:8px;">No CSV files found.</p>';
  }
}

/** Re-fetch CSV content for any queued TC whose file mtime changed or was deleted. */
async function _refreshStaleSeqItems(treeData) {
  if (!state.tcSeqList.length) return;
  const mtimeMap = flattenTreeMtimes((treeData || _lastCsvTreeData)?.tree);
  let seqListDirty = false;

  for (let i = 0; i < state.tcSeqList.length; i++) {
    const tc = state.tcSeqList[i];
    if (!tc.path) continue;

    const currentMtime = mtimeMap.get(tc.path);
    if (currentMtime === undefined) {
      // File deleted from disk
      if (!tc._missing) {
        tc._missing = true;
        seqListDirty = true;
        toast(`CSV 삭제됨: ${tc.name}`, 'warn');
      }
      continue;
    }

    if (tc._missing) { tc._missing = false; seqListDirty = true; }

    // mtime matches stored — nothing to do
    if (tc.mtime !== undefined && tc.mtime === currentMtime) continue;

    // mtime changed (content or name) — reload rows
    try {
      const d = await api(`/api/testcases/csv-content?path=${encodeURIComponent(tc.path)}`);
      tc.rows    = d.rows || [];
      tc.headers = d.headers || tc.headers || [];
      tc.mtime   = currentMtime;
      // Re-render detail panel if this TC is currently selected
      if (i === state.selectedSeqTcIdx) renderCsvSequence(tc.rows);
    } catch { /* leave stale rows intact */ }
  }

  if (seqListDirty) renderTcSeqList();
}

function renderCsvTree(tree) {
  const root = $('csvTree');
  if (!root) return;
  const prev = root.querySelector('.selected')?.getAttribute('data-path') || state.selectedCsvPath;

  function renderNodes(nodes, depth) {
    let h = '';
    for (const n of (nodes || [])) {
      const pad = depth > 0 ? `padding-left:${depth * 14}px;` : '';
      if (n.type === 'file') {
        if (n.isPacket) {
          h += `<div class="csv-root-item" data-path="${esc(n.path)}" title="${esc(n.file)} — packet reference" style="${pad}">
            &#x1F4C4; ${esc(n.name)}
          </div>`;
        } else {
          h += `<div class="csv-leaf" data-path="${esc(n.path)}" title="${esc(n.file)}" style="${pad}">
            <input type="checkbox" name="csv-leaf-chk" class="csv-leaf-chk" data-path="${esc(n.path)}" style="flex-shrink:0;" onclick="event.stopPropagation()">
            <span>${esc(n.name)}</span>
          </div>`;
        }
      } else if (n.type === 'dir') {
        h += `<div class="csv-group">
          <div class="csv-group-head" style="${pad}">&#x1F4C1; ${esc(n.name)}</div>
          ${renderNodes(n.children, depth + 1)}
        </div>`;
      }
    }
    return h;
  }

  const html = renderNodes(tree.tree || [], 0);
  if (!html) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;padding:8px;">No CSV files in testScenarios/.</p>'; return; }
  root.innerHTML = html;

  root.querySelectorAll('.csv-leaf, .csv-root-item').forEach(el => {
    el.addEventListener('click', async e => {
      if (e.target.type === 'checkbox') return;
      root.querySelectorAll('.csv-leaf, .csv-root-item').forEach(e2 => e2.classList.remove('selected'));
      el.classList.add('selected');
      const csvPath = el.getAttribute('data-path');
      state.selectedCsvPath = csvPath;
      // Scenario CSV (csv-leaf = non-packet): preview rows in detail panel + load packets
      if (el.classList.contains('csv-leaf')) {
        try {
          const name = csvPath.split('/').pop().replace(/\.csv$/i, '');
          state.selectedSeqTcIdx = -1;
          state.selectedSeqRowIdx = -1;

          if (_tcSessionCache.has(csvPath)) {
            // Already visited this session — restore without hitting disk
            const c = _tcSessionCache.get(csvPath);
            state.seqItems       = c.seqRows;
            state.seqItemHeaders = c.seqHeaders;
            state.tcPackets      = c.tcPackets;
            state.tcOriginalRefs = c.tcOriginalRefs;
            state.tcNextFrameRef = c.tcNextFrameRef;
            state.tcActivePath   = csvPath;
            state.activeList     = 'tc';
            const titleEl = $('scDetailTitle');
            if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
            renderTcSeqList();
            renderCsvSequence(state.seqItems);
            _syncTcPacketsToSeq();
            updateTcUI();
            selectPacket(-1);
            updateEstimatedTime();
            toast(`TC: ${name} — ${state.tcPackets.length}개 패킷 (세션)`, 'ok');
          } else {
            // First visit — save current TC to cache, then load from disk
            _saveTcToSessionCache();
            const data = await api(`/api/testcases/csv-content?path=${encodeURIComponent(csvPath)}`);
            const titleEl = $('scDetailTitle');
            if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
            state.seqItemHeaders = data.headers || [];
            state.seqItems       = data.rows   || [];
            renderTcSeqList();
            renderCsvSequence(data.rows || []);
            await selectTcCsv(csvPath);
          }
        } catch (err) { toast(`CSV load: ${err.message}`, 'bad'); }
      }
    });
  });

  const selectAllChk = $('csvSelectAll');
  if (selectAllChk) {
    selectAllChk.onchange = e => {
      root.querySelectorAll('.csv-leaf-chk').forEach(c => { c.checked = e.target.checked; });
    };
  }

  if (prev) {
    const sel = root.querySelector(`[data-path="${CSS.escape ? CSS.escape(prev) : prev}"]`);
    if (sel) { sel.classList.add('selected'); state.selectedCsvPath = prev; }
  }
}

async function tcAddToSeq() {
  // Collect all checked csv-leaf paths; fall back to currently selected path
  const checkedEls = document.querySelectorAll('.csv-leaf-chk:checked');
  const paths = checkedEls.length > 0
    ? Array.from(checkedEls).map(c => c.dataset.path).filter(Boolean)
    : (state.selectedCsvPath ? [state.selectedCsvPath] : []);
  if (!paths.length) { toast('왼쪽에서 TC를 선택하거나 체크하세요', 'warn'); return; }

  const mtimes = flattenTreeMtimes(_lastCsvTreeData?.tree);
  let added = 0, dup = 0;
  const firstAddIdx = state.tcSeqList.length;

  for (const path of paths) {
    if (state.tcSeqList.find(tc => tc.path === path)) { dup++; continue; }
    try {
      const data = await api(`/api/testcases/csv-content?path=${encodeURIComponent(path)}`);
      const name = path.split('/').pop().replace(/\.csv$/i, '');
      const freshRows = (data.rows || []).map(r => ({...r}));
      state.tcSeqList.push({
        path, name, status: 'pending',
        rows: freshRows,
        originalRows: freshRows.map(r => ({...r})),
        headers: data.headers || [],
        mtime: mtimes.get(path),
      });
      added++;
    } catch (err) { toast(`로드 실패 (${path}): ${err.message}`, 'bad'); }
  }

  if (!added && !dup) return;
  renderTcSeqList();
  if (added && state.selectedSeqTcIdx < 0) selectSeqTc(firstAddIdx);
  toast(added ? `${added}개 TC 추가${dup ? `, ${dup}개 중복 건너뜀` : ''}` : `모두 이미 시퀀스에 있음`, added ? 'ok' : 'warn');
}

const _CSV_BASE_COLS = new Set([
  'Test_Scenario_ID','TC_Id','TC_ID','TC_id','Index','Name',
  'EventType','Event Type','MAC','timeout','Timeout',
]);

function buildCsvRowDetails(row) {
  const evType = (row['EventType'] || row['Event Type'] || '').toLowerCase();
  if (evType === 'packet') {
    const frameRef = row['FrameRef'] || row['frameref'] || '';
    const pkt = (state.tcPackets || []).find(p => p.name === frameRef);
    if (pkt) {
      const eth = pkt.blocks?.find(b => b.type === 'Ethernet') || {};
      const seqIdx = row['Index'] ?? ((state.tcPackets || []).indexOf(pkt) + 1);
      return `#${seqIdx}  Dst: ${eth.dstMac || '-'}   Src: ${eth.srcMac || '-'}`;
    }
    return frameRef ? `FrameRef: ${frameRef}` : '';
  }
  return Object.entries(row)
    .filter(([k, v]) => !_CSV_BASE_COLS.has(k) && v && v.trim() && v !== '-')
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ');
}

let _seqDragFrom = -1;

/** Returns the rows currently shown in the detail panel (editable). */
function _getSeqRows() {
  const tc = state.tcSeqList[state.selectedSeqTcIdx];
  return tc ? tc.rows : state.seqItems;
}
/** Updates the rows, renormalizes indices, and re-renders. */
function _setSeqRows(rows) {
  rows.forEach((r, i) => { r['Index'] = String(i + 1); });
  const tc = state.tcSeqList[state.selectedSeqTcIdx];
  if (tc) tc.rows = rows;
  renderCsvSequence(rows);
}

function renderCsvSequence(rows) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  state.seqItems = rows || [];
  state.seqItems.forEach((r, i) => { r['Index'] = String(i + 1); });
  if (state.selectedSeqRowIdx >= rows.length) state.selectedSeqRowIdx = rows.length - 1;
  if (!rows || !rows.length) {
    tbody.innerHTML = '';
    return;
  }
  tbody.innerHTML = rows.map((row, i) => {
    const idx     = row['Index'] !== undefined ? row['Index'] : String(i + 1);
    const name    = row['Name'] || '';
    const evType  = row['EventType'] || row['Event Type'] || '';
    const mac     = row['MAC'] || '';
    const details = buildCsvRowDetails(row);
    const sel      = i === state.selectedSeqRowIdx ? ' row-selected' : '';
    const result   = row._result || '';
    const rStyle   = result === 'Done' ? ';color:var(--green)' : result === 'Fail' ? ';color:var(--red)' : '';
    const isPacket = evType.toLowerCase() === 'packet';
    const ifaceOpts = state.interfaces.map(ifc =>
      `<option value="${esc(ifc.name)}"${(row._iface||'')=== ifc.name?' selected':''}>${esc(ifc.name)}${ifc.state==='up'?' ●':''}</option>`
    ).join('');
    const ifaceCell = isPacket
      ? `<select name="sc-row-iface-${i}" class="sc-row-iface-sel small-select" data-row-idx="${i}" style="width:120px;font-size:10px;">
           <option value="">-- iface --</option>${ifaceOpts}
         </select>`
      : '';
    return `<tr data-idx="${i}" draggable="true" class="${sel}">
      <td><input type="checkbox" name="sc-row-chk" class="sc-row-chk" data-idx="${i}"></td>
      <td style="color:var(--muted);">${esc(idx)}</td>
      <td>${esc(name)}</td>
      <td><span class="ev-badge ev-${esc(evType.toLowerCase())}">${esc(evType)}</span></td>
      <td class="mono" style="font-size:10px;">${esc(mac)}</td>
      <td style="color:var(--muted);font-size:10px;">${esc(details)}</td>
      <td>${ifaceCell}</td>
      <td style="font-size:11px;font-weight:600${rStyle}" title="${esc(row._resultDetail||'')}">${esc(result)}</td>
    </tr>`;
  }).join('');

  const saChk = $('scSeqSelectAll');
  if (saChk) saChk.onchange = e => { tbody.querySelectorAll('.sc-row-chk').forEach(c => { c.checked = e.target.checked; }); };

  tbody.querySelectorAll('.sc-row-iface-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const rowIdx = parseInt(sel.dataset.rowIdx);
      const rows2 = _getSeqRows();
      if (rows2[rowIdx]) rows2[rowIdx]._iface = sel.value;
    });
  });

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', e => {
      if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      state.selectedSeqRowIdx = i;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('row-selected'));
      tr.classList.add('row-selected');
    });
    tr.addEventListener('dragstart', e => {
      _seqDragFrom = i;
      e.dataTransfer.setData('text/x-seq-row', String(i));
      e.dataTransfer.effectAllowed = 'move';
      tr.classList.add('dragging');
    });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); _seqDragFrom = -1; });
    tr.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-seq-row')) { e.preventDefault(); tr.classList.add('drag-over'); }
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', e => {
      e.preventDefault(); tr.classList.remove('drag-over');
      if (!e.dataTransfer.types.includes('text/x-seq-row')) return; // palette drop — let bubble
      const from = Number(e.dataTransfer.getData('text/x-seq-row') ?? '-1');
      if (isNaN(from) || from < 0 || from === i) { _seqDragFrom = -1; return; }
      const rows2 = _getSeqRows();
      const [moved] = rows2.splice(from, 1);
      const insertAt = from < i ? i - 1 : i;
      rows2.splice(insertAt, 0, moved);
      state.selectedSeqRowIdx = insertAt;
      _seqDragFrom = -1;
      _setSeqRows(rows2);
      if (state.activeList === 'tc') { _syncTcPacketsToSeq(); renderPacketList(); }
    });
  });
}

// ── Sequence row edit (5 buttons) ────────────────────────────────────────────
function scRowAdd() {
  const rows = _getSeqRows();
  const newRow = { Index: '', Name: '', EventType: 'Delay', MAC: '-', Timeout: '' };
  const idx = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
  rows.splice(idx, 0, newRow);
  state.selectedSeqRowIdx = idx;
  _setSeqRows(rows);
}

function scRowDel() {
  const rows = _getSeqRows();
  if (state.selectedSeqRowIdx < 0 || state.selectedSeqRowIdx >= rows.length) { toast('먼저 행을 선택하세요', 'warn'); return; }
  rows.splice(state.selectedSeqRowIdx, 1);
  state.selectedSeqRowIdx = Math.min(state.selectedSeqRowIdx, rows.length - 1);
  _setSeqRows(rows);
}

function scRowDup() {
  const rows = _getSeqRows();
  if (state.selectedSeqRowIdx < 0 || state.selectedSeqRowIdx >= rows.length) { toast('먼저 행을 선택하세요', 'warn'); return; }
  const dup = { ...rows[state.selectedSeqRowIdx] };
  const idx = state.selectedSeqRowIdx + 1;
  rows.splice(idx, 0, dup);
  state.selectedSeqRowIdx = idx;
  _setSeqRows(rows);
}

function scRowMoveUp() {
  const rows = _getSeqRows();
  const i = state.selectedSeqRowIdx;
  if (i <= 0) return;
  [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
  state.selectedSeqRowIdx = i - 1;
  _setSeqRows(rows);
}

function scRowMoveDown() {
  const rows = _getSeqRows();
  const i = state.selectedSeqRowIdx;
  if (i < 0 || i >= rows.length - 1) return;
  [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
  state.selectedSeqRowIdx = i + 1;
  _setSeqRows(rows);
}

// ── Event palette → sequence table DnD ───────────────────────────────────────
function initPaletteDnD() {
  document.querySelectorAll('.palette-item[data-event]').forEach(el => {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-palette-event', el.dataset.event);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  // Table area: accept palette drops (insert row) and keep seq-row drops working
  const tableArea = $('scTableArea');
  if (tableArea) {
    tableArea.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-palette-event')) {
        e.preventDefault();
        tableArea.classList.add('drop-target');
      }
    });
    tableArea.addEventListener('dragleave', e => {
      if (!tableArea.contains(e.relatedTarget)) tableArea.classList.remove('drop-target');
    });
    tableArea.addEventListener('drop', e => {
      tableArea.classList.remove('drop-target');
      const evType = e.dataTransfer.getData('text/x-palette-event');
      if (!evType) return;
      e.preventDefault();
      const rows = _getSeqRows();
      const newRow = { Index: '', Name: evType, EventType: evType, MAC: '-', Timeout: '' };
      // Insert before the hovered row; if dropped on empty area, append at end
      const targetTr = e.target.closest?.('tr[data-idx]');
      const idx = targetTr ? parseInt(targetTr.dataset.idx ?? rows.length) : rows.length;
      rows.splice(idx, 0, newRow);
      state.selectedSeqRowIdx = idx;
      _setSeqRows(rows);
    });
  }

  // Bottom drop zone — move or insert row at end of list
  const seqDropEnd = $('scSeqDropEnd');
  if (seqDropEnd) {
    seqDropEnd.addEventListener('dragover', e => {
      const ok = e.dataTransfer.types.includes('text/x-seq-row') || e.dataTransfer.types.includes('text/x-palette-event');
      if (ok) { e.preventDefault(); seqDropEnd.classList.add('drag-over'); }
    });
    seqDropEnd.addEventListener('dragleave', () => seqDropEnd.classList.remove('drag-over'));
    seqDropEnd.addEventListener('drop', e => {
      e.preventDefault(); seqDropEnd.classList.remove('drag-over');
      const rows2 = _getSeqRows();
      if (e.dataTransfer.types.includes('text/x-seq-row')) {
        const from = Number(e.dataTransfer.getData('text/x-seq-row') ?? '-1');
        if (isNaN(from) || from < 0 || from >= rows2.length) { _seqDragFrom = -1; return; }
        const [moved] = rows2.splice(from, 1);
        rows2.push(moved);
        state.selectedSeqRowIdx = rows2.length - 1;
        _seqDragFrom = -1;
        _setSeqRows(rows2);
        if (state.activeList === 'tc') { _syncTcPacketsToSeq(); renderPacketList(); }
      } else if (e.dataTransfer.types.includes('text/x-palette-event')) {
        const evType = e.dataTransfer.getData('text/x-palette-event');
        if (!evType) return;
        const newRow = { Index: '', Name: evType, EventType: evType, MAC: '-', Timeout: '' };
        rows2.push(newRow);
        state.selectedSeqRowIdx = rows2.length - 1;
        _setSeqRows(rows2);
      }
    });
  }

  // Event panel: drop a seq-row here to remove it
  const evPanel = $('scEventPanel');
  if (evPanel) {
    evPanel.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-seq-row')) {
        e.preventDefault();
        evPanel.classList.add('drop-remove');
      }
    });
    evPanel.addEventListener('dragleave', e => {
      if (!evPanel.contains(e.relatedTarget)) evPanel.classList.remove('drop-remove');
    });
    evPanel.addEventListener('drop', e => {
      evPanel.classList.remove('drop-remove');
      const idxStr = e.dataTransfer.getData('text/x-seq-row');
      if (idxStr === '') return;
      e.preventDefault();
      const rowIdx = Number(idxStr);
      const rows = _getSeqRows();
      if (rowIdx >= 0 && rowIdx < rows.length) {
        rows.splice(rowIdx, 1);
        state.selectedSeqRowIdx = Math.min(rowIdx, rows.length - 1);
        _setSeqRows(rows);
      }
    });
  }
}

// ── CSV Save (session-only, no disk write) ───────────────────────────────────
function saveCsvTc() {
  const tc   = state.tcSeqList[state.selectedSeqTcIdx];
  const path = tc?.path ?? state.selectedCsvPath;
  if (!path) { toast('저장할 CSV 경로가 없습니다', 'warn'); return; }
  _saveTcToSessionCache();
  const name = path.split('/').pop().replace(/\.csv$/i, '');
  toast(`[${name}] 세션에 반영됨 (서버 재시작 시 초기화)`, 'ok');
}

function startCsvPoller() {
  if (_csvPollTimer) return;
  _csvPollTimer = setInterval(loadCsvTree, 5000);
}

// ── TEST SEQUENCE panel (Panel 3) ─────────────────────────────────────────────
let _tcSeqDragFrom = -1;

function renderTcSeqList() {
  const el = $('tcSeqList');
  if (!el) return;
  if (!state.tcSeqList.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px;padding:12px;">No TC queued. Select one on the left and press ›.</div>';
    return;
  }
  el.innerHTML = state.tcSeqList.map((tc, i) => {
    const dotClass = tc._missing             ? 'missing'
                   : tc.status === 'running' ? 'running'
                   : tc.status === 'pass'    ? 'pass'
                   : tc.status === 'fail'    ? 'fail' : 'pending';
    return `<div class="tc-seq-row${i === state.selectedSeqTcIdx ? ' selected' : ''}" data-idx="${i}" draggable="true">
      <span class="tc-drag-handle" title="Drag to reorder">⠿</span>
      <span class="tc-dot ${dotClass}" title="${tc.status}"></span>
      <span class="tc-seq-idx">${i+1}</span>
      <span class="tc-seq-name" title="${esc(tc.name)}">${esc(tc.name)}</span>
    </div>`;
  }).join('') + '<div class="tc-seq-drop-end"></div>';

  el.querySelectorAll('.tc-seq-row').forEach((row, i) => {
    row.addEventListener('click', () => selectSeqTc(i));
    row.addEventListener('contextmenu', e => { e.preventDefault(); _showSeqCtxMenu(e.clientX, e.clientY, i); });
    row.addEventListener('dragstart', e => { _tcSeqDragFrom = i; row.style.opacity = '.4'; e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend',   () => { row.style.opacity = ''; _tcSeqDragFrom = -1; });
    row.addEventListener('dragover',  e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      if (_tcSeqDragFrom < 0 || _tcSeqDragFrom === i) { _tcSeqDragFrom = -1; return; }
      const selTc = state.tcSeqList[state.selectedSeqTcIdx];
      const [moved] = state.tcSeqList.splice(_tcSeqDragFrom, 1);
      const insertAt = _tcSeqDragFrom < i ? i - 1 : i;
      state.tcSeqList.splice(insertAt, 0, moved);
      state.selectedSeqTcIdx = selTc ? state.tcSeqList.indexOf(selTc) : -1;
      _tcSeqDragFrom = -1;
      renderTcSeqList();
    });
  });

  // Drop zone at the bottom: append to end
  const endZone = el.querySelector('.tc-seq-drop-end');
  if (endZone) {
    endZone.addEventListener('dragover',  e => { e.preventDefault(); endZone.classList.add('drag-over'); });
    endZone.addEventListener('dragleave', () => endZone.classList.remove('drag-over'));
    endZone.addEventListener('drop', e => {
      e.preventDefault(); endZone.classList.remove('drag-over');
      if (_tcSeqDragFrom < 0) return;
      const selTc = state.tcSeqList[state.selectedSeqTcIdx];
      const [moved] = state.tcSeqList.splice(_tcSeqDragFrom, 1);
      state.tcSeqList.push(moved);
      state.selectedSeqTcIdx = selTc ? state.tcSeqList.indexOf(selTc) : -1;
      _tcSeqDragFrom = -1;
      renderTcSeqList();
    });
  }
}

// ── Sequence context menu ─────────────────────────────────────────────────────
let _seqCtxMenu = null;

function _showSeqCtxMenu(x, y, idx) {
  _hideSeqCtxMenu();
  _seqCtxMenu = document.createElement('div');
  _seqCtxMenu.className = 'ctx-menu';
  _seqCtxMenu.style.cssText = `left:${x}px;top:${y}px;`;
  _seqCtxMenu.innerHTML = `<div class="ctx-item ctx-remove">✕ 시퀀스에서 제거</div>`;
  document.body.appendChild(_seqCtxMenu);
  _seqCtxMenu.querySelector('.ctx-remove').addEventListener('click', () => {
    _hideSeqCtxMenu();
    state.tcSeqList.splice(idx, 1);
    if (state.selectedSeqTcIdx >= state.tcSeqList.length)
      state.selectedSeqTcIdx = state.tcSeqList.length - 1;
    renderTcSeqList();
    if (state.selectedSeqTcIdx >= 0) selectSeqTc(state.selectedSeqTcIdx);
    else {
      const t = $('scDetailTitle'); if (t) t.textContent = 'TEST SEQUENCE — (select a TC)';
      const b = $('sequenceRows');
      if (b) b.innerHTML = '';
    }
  });
  setTimeout(() => document.addEventListener('click', _hideSeqCtxMenu, { once: true }), 0);
}

function _hideSeqCtxMenu() {
  if (_seqCtxMenu) { _seqCtxMenu.remove(); _seqCtxMenu = null; }
}

async function selectSeqTc(idx) {
  // Save current TC state BEFORE switching context so seqItems still reflects old TC
  _saveTcToSessionCache();
  state.selectedSeqTcIdx = idx;
  state.selectedSeqRowIdx = -1;
  const tc = state.tcSeqList[idx];
  const titleEl = $('scDetailTitle');
  if (titleEl) titleEl.textContent = tc ? `TEST SEQUENCE — ${tc.name}` : 'TEST SEQUENCE — (select a TC)';
  if (tc) {
    renderCsvSequence(tc.rows || []);
    // Also load this TC's packets into PG view (TC mode)
    await _activateTcPackets(tc.path, tc.rows);
  } else {
    const tbody = $('sequenceRows'); if (tbody) tbody.innerHTML = '';
  }
  renderTcSeqList();
}

// ── Run State Management ──────────────────────────────────────────────────────
function setRunState(mode) {
  state.seqRunning  = mode === 'seq';
  state.sendRunning = mode === 'selSend' || mode === 'listSend';

  const seqRunBtn = $('seqRun');
  if (seqRunBtn) {
    if (mode === 'seq') {
      seqRunBtn.textContent = '■ Stop'; seqRunBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;';
    } else {
      seqRunBtn.textContent = '▶ Run Seq'; seqRunBtn.style.cssText = 'background:var(--green);border-color:var(--green);color:#000;';
      seqRunBtn.disabled = !!(mode === 'selSend' || mode === 'listSend');
    }
  }
  const selBtn = $('scSendSelected');
  if (selBtn) {
    if (mode === 'selSend') {
      selBtn.textContent = '■ Stop'; selBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; selBtn.className = 'small';
    } else {
      selBtn.textContent = '▶ Send Selected'; selBtn.style.cssText = ''; selBtn.className = 'small';
      selBtn.disabled = !!(mode === 'seq' || mode === 'listSend');
    }
  }
  const listBtn = $('scSendList');
  if (listBtn) {
    if (mode === 'listSend') {
      listBtn.textContent = '■ Stop'; listBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; listBtn.className = 'small';
    } else {
      listBtn.textContent = '▶▶ Send List'; listBtn.style.cssText = ''; listBtn.className = 'small primary';
      listBtn.disabled = !!(mode === 'seq' || mode === 'selSend');
    }
  }
  const spin = $('seqRunSpinner');
  if (spin) spin.style.display = mode === 'seq' ? '' : 'none';
}

function stopRunning() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  state._runAbort = true;
  const sc = $('scSelSpinner');  if (sc)  sc.style.display = 'none';
  const sl = $('scListSpinner'); if (sl) sl.style.display = 'none';
  setRunState(null);
}

// ── Event executor ────────────────────────────────────────────────────────────
async function executeEvent(row, iface) {
  const evType = (row['EventType'] || row['Event Type'] || '').toLowerCase().trim();

  if (evType === 'delay') {
    const ms = Math.min(parseInt(row['Timeout'] || row['timeout'] || '200') || 200, 30000);
    await new Promise(r => setTimeout(r, ms));
    return { ok: true };
  }

  if (evType === 'regwrite' || evType === 'registerwrite') {
    const offset = row['Address'] || row['address'] || '';
    const value  = row['Value']   || row['value']   || '';
    if (!offset) return { ok: false, error: 'No Address' };
    try {
      const data = await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'Write failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (evType === 'regread' || evType === 'registerread') {
    const offset = row['Address'] || row['address'] || '';
    if (!offset) return { ok: false, error: 'No Address' };
    try {
      const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
      return data.ok !== false ? { ok: true, detail: data.value || '' } : { ok: false, error: data.error || 'Read failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (evType === 'regverify' || evType === 'registerverify' || evType === 'registerexpect' || evType === 'verify') {
    const offset    = row['Address']  || row['address']  || '';
    const expected  = row['Expected'] || row['expected'] || '0x0';
    const mask      = row['Mask']     || row['mask']     || '0xFFFFFFFF';
    const timeoutMs = parseInt(row['Timeout'] || row['timeout'] || '1000') || 1000;
    if (!offset) return { ok: false, error: 'No Address' };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
        if (data.ok === false) return { ok: false, error: data.error || 'Read failed' };
        const actual  = parseInt(data.value || '0', 16) || data.valueDec || 0;
        const expVal  = parseInt(expected, 16) || 0;
        const maskVal = parseInt(mask, 16) !== 0 ? parseInt(mask, 16) : 0xFFFFFFFF;
        if ((actual & maskVal) === (expVal & maskVal))
          return { ok: true, detail: `0x${actual.toString(16).toUpperCase()}` };
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 100));
    }
    return { ok: false, error: `Verify timeout (${timeoutMs}ms)` };
  }

  if (evType === 'fdbinitialize' || evType === 'fdbflush') {
    try {
      const data = await api('/api/fdb/flush', { method: 'POST', body: JSON.stringify({}) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'FDB flush failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (evType === 'fdbwrite') {
    const mac    = row['MAC'] || row['mac'] || '';
    const vlanId = parseInt(row['VlanId'] || row['vlanid'] || '0') || 0;
    const port   = parseInt(row['Port']   || row['port']   || '0') || 0;
    if (!mac) return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/write', { method: 'POST', body: JSON.stringify({ mac, vlanId, port }) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'FDB write failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (evType === 'fdbread') {
    const mac    = row['MAC'] || row['mac'] || '';
    const vlanId = parseInt(row['VlanId'] || row['vlanid'] || '0') || 0;
    if (!mac) return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/read', { method: 'POST', body: JSON.stringify({ mac, vlanId }) });
      return data.ok !== false ? { ok: true, detail: JSON.stringify(data.entry || {}) } : { ok: false, error: data.error || 'FDB read failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  if (evType === 'fdbwaitfor') {
    const mac       = row['MAC'] || row['mac'] || '';
    const vlanId    = parseInt(row['VlanId'] || row['vlanid'] || '0') || 0;
    const timeoutMs = parseInt(row['Timeout'] || row['timeout'] || '5000') || 5000;
    if (!mac) return { ok: false, error: 'No MAC' };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const data = await api('/api/fdb/read', { method: 'POST', body: JSON.stringify({ mac, vlanId }) });
        if (data.ok !== false && data.entry) return { ok: true };
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: false, error: `FDB entry not found (${timeoutMs}ms)` };
  }

  if (evType === 'packet') {
    const frameRef = row['FrameRef'] || row['frameref'] || row['Name'] || '';
    const pkt = (state.tcPackets || []).find(p => p.name === frameRef) || getActivePackets().find(p => p.name === frameRef);
    if (!pkt) return { ok: false, error: `Packet not found: ${frameRef}` };
    try {
      const payload = buildPacketPayload(pkt);
      const effectiveIface = row._iface || iface;
      if (effectiveIface) payload.interface = effectiveIface;
      const data = await api('/api/packet/send', { method: 'POST', body: JSON.stringify(payload) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'Send failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // rxverify, fdbwritebucket, fdbreadbucket, unknown → skip
  await new Promise(r => setTimeout(r, 20));
  return { ok: true, detail: 'Skipped' };
}

// ── Row result updater (in-place, no full re-render) ─────────────────────────
function setRowResult(rowIdx, result, detail) {
  const rows = _getSeqRows();
  if (rowIdx < 0 || rowIdx >= rows.length) return;
  rows[rowIdx]._result       = result;
  rows[rowIdx]._resultDetail = detail || '';
  const tbody = $('sequenceRows');
  if (!tbody) return;
  const trs = tbody.querySelectorAll('tr');
  if (!trs[rowIdx]) return;
  const tds    = trs[rowIdx].querySelectorAll('td');
  const lastTd = tds[tds.length - 1];
  if (!lastTd) return;
  const clr = result === 'Done' ? ';color:var(--green)' : result === 'Fail' ? ';color:var(--red)' : '';
  lastTd.style.cssText = `font-size:11px;font-weight:600${clr}`;
  lastTd.textContent   = result;
  lastTd.title         = detail || '';
}

async function runSeqSequence() {
  if (!state.tcSeqList.length) { toast('No TCs in sequence — press › to add some', 'warn'); return; }
  const failIgnore = $('scFailIgnore')?.checked || false;
  const iface      = $('scInterface')?.value    || '';
  state._runAbort  = false;
  setRunState('seq');
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm('▶ Starting sequence run…');

  for (let i = 0; i < state.tcSeqList.length; i++) {
    if (state._runAbort) break;
    const tc = state.tcSeqList[i];
    tc.status = 'running';
    selectSeqTc(i);
    appendSeqTerm(`  ▶ [${i+1}/${state.tcSeqList.length}] ${tc.name}`);

    // Clear previous results for this TC
    for (const row of (tc.rows || [])) { row._result = ''; row._resultDetail = ''; }
    renderCsvSequence(tc.rows || []);

    let tcOk = true;
    for (let j = 0; j < (tc.rows || []).length; j++) {
      if (state._runAbort) break;
      const row = tc.rows[j];
      const ev  = (row['EventType'] || row['Event Type'] || '').toLowerCase();
      setRowResult(j, '…', '');
      let res;
      try { res = await executeEvent(row, iface); }
      catch (err) { res = { ok: false, error: err.message }; }
      const resultStr = res.ok ? 'Done' : 'Fail';
      setRowResult(j, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
      appendSeqTerm(`    ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
      if (!res.ok) {
        tcOk = false;
        if (!failIgnore) break;
      }
    }

    tc.status = tcOk ? 'pass' : 'fail';
    renderTcSeqList();
    appendSeqTerm(`  ${tcOk ? '✓ PASS' : '✗ FAIL'}: ${tc.name}`);
    if (!tcOk && !failIgnore) { toast(`TC Fail: ${tc.name}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  setRunState(null);
  if (!state._runAbort) toast('Sequence complete', 'ok');
  else appendSeqTerm('■ Sequence aborted');
}

async function scenarioSendSelected() {
  const iface = '';
  const rows  = _getSeqRows();
  if (!rows.length) { toast('No rows — TC를 선택하거나 왼쪽에서 CSV를 클릭하세요', 'warn'); return; }
  const checkedIdxs = [];
  const tbody = $('sequenceRows');
  if (tbody) tbody.querySelectorAll('.sc-row-chk').forEach((c, i) => { if (c.checked) checkedIdxs.push(i); });
  if (!checkedIdxs.length) { toast('최소 한 행을 체크하세요', 'warn'); return; }

  const failIgnore = $('scFailIgnore')?.checked || false;
  for (const idx of checkedIdxs) { rows[idx]._result = ''; rows[idx]._resultDetail = ''; }
  renderCsvSequence(rows);

  state._runAbort = false;
  setRunState('selSend');
  const sp = $('scSelSpinner'); if (sp) sp.style.display = '';
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm(`▶ Send Selected (${checkedIdxs.length} rows)…`);

  for (const idx of checkedIdxs) {
    if (state._runAbort) break;
    const row = rows[idx];
    const ev  = (row['EventType'] || row['Event Type'] || '').toLowerCase();
    setRowResult(idx, '…', '');
    let res;
    try { res = await executeEvent(row, iface); }
    catch (err) { res = { ok: false, error: err.message }; }
    const resultStr = res.ok ? 'Done' : 'Fail';
    setRowResult(idx, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
    appendSeqTerm(`  ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
    if (!res.ok && !failIgnore) { toast(`Fail: ${ev} — ${res.error}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  if (sp) sp.style.display = 'none';
  setRunState(null);
  if (!state._runAbort) toast('Send Selected complete', 'ok');
}

async function scenarioSendList() {
  const iface = '';
  const rows  = _getSeqRows();
  if (!rows.length) { toast('No rows — TC를 선택하거나 왼쪽에서 CSV를 클릭하세요', 'warn'); return; }

  const failIgnore = $('scFailIgnore')?.checked || false;
  for (const row of rows) { row._result = ''; row._resultDetail = ''; }
  renderCsvSequence(rows);

  state._runAbort = false;
  setRunState('listSend');
  const sp = $('scListSpinner'); if (sp) sp.style.display = '';
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm(`▶ Send List (${rows.length} rows)…`);

  for (let i = 0; i < rows.length; i++) {
    if (state._runAbort) break;
    const row = rows[i];
    const ev  = (row['EventType'] || row['Event Type'] || '').toLowerCase();
    setRowResult(i, '…', '');
    let res;
    try { res = await executeEvent(row, iface); }
    catch (err) { res = { ok: false, error: err.message }; }
    const resultStr = res.ok ? 'Done' : 'Fail';
    setRowResult(i, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
    appendSeqTerm(`  ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
    if (!res.ok && !failIgnore) { toast(`Fail: ${ev} — ${res.error}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  if (sp) sp.style.display = 'none';
  setRunState(null);
  if (!state._runAbort) toast('Send List complete', 'ok');
}

// Stubs for dead IDs referenced in preserved init() — must exist to avoid ReferenceError
function confirmEventModal()   {}
function closeEventModal()     {}
function addTcFromCurrent()    {}
async function readRegister()  {}
async function writeRegister() {}

async function refreshRegStatus() {
  try {
    const data = await api('/api/register/status');
    if (data.baseAddress !== undefined) {
      const b = typeof data.baseAddress === 'number' ? `0x${data.baseAddress.toString(16).toUpperCase().padStart(8,'0')}` : data.baseAddress;
      if ($('regBaseAddr')) $('regBaseAddr').value = b;
    }
  } catch { /* offline */ }
}

// ── Sequence Terminal ─────────────────────────────────────────────────────────
function appendSeqTerm(text) {
  const el = $('seqTerminal');
  if (!el) return;
  if (el.textContent === 'No output.') el.textContent = '';
  el.textContent += `${tsNow()}  ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

async function seqTermSend() {
  const text = $('seqTermInput')?.value.trim();
  if (!text) return;
  try {
    await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ text }) });
    appendHyperTerm(`> ${text}`);
    $('seqTermInput').value = '';
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}


// ── Register Viewer (HyperTerminal) ──────────────────────────────────────────
function setRegStatus(id, text, isOk) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `reg-status${isOk ? ' ok' : ''}`;
  if (isOk) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'reg-status'; } }, 3000);
}

async function rvRead(offset, valId, statusId) {
  try {
    const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
    const val = data.value || `0x${(data.valueDec || 0).toString(16).toUpperCase().padStart(8,'0')}`;
    if (valId && $(valId)) $(valId).value = val;
    setRegStatus(statusId, 'OK', true);
    return data;
  } catch (err) { setRegStatus(statusId, `Error: ${err.message}`, false); }
}

async function rvWrite(offset, value, statusId) {
  try {
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
    setRegStatus(statusId, 'Write OK', true);
  } catch (err) { setRegStatus(statusId, `Error: ${err.message}`, false); }
}

function parseSysCtrlVersion(v) {
  const major = (v >>> 24) & 0xFF;
  const year  = (v >>> 16) & 0xFF;
  const month = (v >>> 12) & 0xF;
  const day   = (v >>>  4) & 0xFF;
  const minor =  v         & 0xF;
  const name  = major === 0x52 ? 'TSGW' : `0x${major.toString(16).toUpperCase().padStart(2,'0')}`;
  const yr    = ((year >> 4) & 0xF) * 10 + (year & 0xF);
  const dy    = ((day  >> 4) & 0xF) * 10 + (day  & 0xF);
  return `${name}  20${String(yr).padStart(2,'0')}-${month}-${String(dy).padStart(2,'0')}  v${minor}`;
}

function syncSysCtrlEnable(v) {
  const ports = (v >>> 8) & 0xFF;
  if ($('rv-en-tsgw')) $('rv-en-tsgw').checked = (v & 1) !== 0;
  for (let i = 0; i < 8; i++) { const el = $(`rv-en-p${i}`); if (el) el.checked = (ports & (1 << i)) !== 0; }
}

function buildSysCtrlEnable() {
  let ports = 0;
  for (let i = 0; i < 8; i++) { if ($(`rv-en-p${i}`)?.checked) ports |= (1 << i); }
  return (($('rv-en-tsgw')?.checked ? 1 : 0) | (ports << 8)) >>> 0;
}

function syncHostIf(v) {
  if ($('rv-ahb-wr')) $('rv-ahb-wr').value = v & 0xF;
  if ($('rv-ahb-rd')) $('rv-ahb-rd').value = (v >>> 4) & 0xF;
}

function buildHostIf() {
  const wr = Math.max(0, Math.min(15, parseInt($('rv-ahb-wr')?.value || '0')));
  const rd = Math.max(0, Math.min(15, parseInt($('rv-ahb-rd')?.value || '0')));
  return ((rd << 4) | wr) >>> 0;
}

// ── FDB register helpers ──────────────────────────────────────────────────────
const FDB_OFF = {
  VERSION:0xA00, FDB_LOAD:0xA04, ENABLE:0xA0C, AGE_PERIOD:0xA10, AGING_THR:0xA14,
  MCU_MAC0:0xA18, MCU_MAC1:0xA1C, MCU_VLAN:0xA20, MCU_PORT:0xA24, MCU_BUCKET:0xA28,
  MCU_CMD:0xA2C, FDB_STATUS:0xA40, CMD_STATUS:0xA44, RD_BUCKET:0xA48, RD_PORT:0xA4C,
  RD_FLAGS:0xA50, RD_MAC0:0xA54, RD_MAC1:0xA58, RD_MAC2:0xA5C,
};
const FDB_CMD = { HASH_READ:0x12, READ_BUCKET:0x13, HASH_WRITE:0x14, WRITE_BUCKET:0x15, HASH_DELETE:0x16, FLUSH_ALL:0x70 };

function parseRegD(d) {
  const raw = d.value || `0x${((d.valueDec||0)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
  return parseInt(raw, 16) >>> 0;
}

async function fdbReg(off) {
  const hex = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset: hex }) });
  return parseRegD(d);
}

async function fdbWr(off, val) {
  const offset = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const value  = `0x${(val >>> 0).toString(16).toUpperCase().padStart(8,'0')}`;
  await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset, value }) });
}

async function fdbPoll(off, mask, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 500);
  while (Date.now() < deadline) {
    if ((await fdbReg(off) & mask) !== 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Poll timeout off=0x${off.toString(16)}`);
}

function fdbEncodeMac(mac) {
  const b = mac.split(':').map(s => parseInt(s, 16));
  return { mac0: ((b[2]<<24)|(b[3]<<16)|(b[4]<<8)|b[5])>>>0, mac1: ((b[0]<<8)|b[1])>>>0 };
}

function fdbDecodeMac(hi16, mid16, lo16) {
  return [(hi16>>8)&0xFF,hi16&0xFF,(mid16>>8)&0xFF,mid16&0xFF,(lo16>>8)&0xFF,lo16&0xFF]
    .map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(':');
}

function fdbInputs() {
  const mac    = $('rv-fdb-mac')?.value.trim() || '00:00:00:00:00:00';
  const vlanId = parseInt($('rv-fdb-vlan')?.value || '0') & 0xFFF;
  const vlanV  = !!$('rv-fdb-vlan-valid')?.checked;
  const port   = parseInt($('rv-fdb-port')?.value || '0') & 0x1FF;
  const bucket = parseInt(($('rv-fdb-bucket')?.value || '0').trim()) & 0x3FF;
  const slot   = parseInt(($('rv-fdb-slot')?.value || '0x1').trim()) & 0xF || 1;
  return { mac, vlanId, vlanV, port, bucket, slot };
}

function fdbAddRow(row) {
  const tbody = $('rv-fdb-tbody');
  if (!tbody) return;
  if (tbody.querySelector('[colspan]')) tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${row.bucket??'-'}</td><td>${row.slot??'-'}</td><td class="mono">${row.mac||'-'}</td><td>${row.port??'-'}</td><td>${row.status??'-'}</td><td>${row.ts??'-'}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

function fdbClearRows() {
  const tbody = $('rv-fdb-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);">No results yet</td></tr>';
}

async function fdbReadByHash() {
  const { mac, vlanId, vlanV } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', 'Reading...', false);
  try {
    const { mac0, mac1 } = fdbEncodeMac(mac);
    await fdbWr(FDB_OFF.MCU_MAC0, mac0); await fdbWr(FDB_OFF.MCU_MAC1, mac1);
    await fdbWr(FDB_OFF.MCU_VLAN, (vlanV?0x1000:0)|vlanId);
    await fdbWr(FDB_OFF.MCU_CMD, FDB_CMD.HASH_READ);
    await fdbPoll(FDB_OFF.CMD_STATUS, 0x1, 500);
    const flags = await fdbReg(FDB_OFF.RD_FLAGS);
    fdbClearRows();
    if ((flags & 0x8000) === 0) { fdbAddRow({mac,port:'-',bucket:'-',slot:'-',ts:'-',status:'Not found'}); setRegStatus('rv-st-fdb-cmd','Not learned',false); }
    else {
      const rdPort=await fdbReg(FDB_OFF.RD_PORT), rdBucket=await fdbReg(FDB_OFF.RD_BUCKET);
      fdbAddRow({mac,port:rdPort&0x1FF,bucket:rdBucket&0x3FF,slot:`0x${((rdBucket>>12)&0xF).toString(16)}`,ts:flags&0x3FFF,status:(flags&0x4000)?'Static':'Dynamic'});
      setRegStatus('rv-st-fdb-cmd','Entry found',true);
    }
  } catch(err) { setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false); }
}

async function fdbReadByBucket() {
  const { bucket, slot } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd','Reading...',false);
  try {
    await fdbWr(FDB_OFF.MCU_BUCKET,((slot&0xF)<<16)|(bucket&0x3FF));
    await fdbWr(FDB_OFF.MCU_CMD,FDB_CMD.READ_BUCKET);
    await fdbPoll(FDB_OFF.CMD_STATUS,0x1,500);
    const flags=await fdbReg(FDB_OFF.RD_FLAGS);
    fdbClearRows();
    if((flags&0x8000)===0){fdbAddRow({bucket,slot:`0x${slot.toString(16)}`,mac:'-',port:'-',ts:'-',status:'Empty'});setRegStatus('rv-st-fdb-cmd','Slot empty',false);}
    else{
      const mac0=await fdbReg(FDB_OFF.RD_MAC0),mac1=await fdbReg(FDB_OFF.RD_MAC1),mac2=await fdbReg(FDB_OFF.RD_MAC2),rdPort=await fdbReg(FDB_OFF.RD_PORT);
      fdbAddRow({bucket,slot:`0x${slot.toString(16)}`,mac:fdbDecodeMac(mac2&0xFFFF,mac1&0xFFFF,mac0&0xFFFF),port:rdPort&0x1FF,ts:flags&0x3FFF,status:(flags&0x4000)?'Static':'Dynamic'});
      setRegStatus('rv-st-fdb-cmd','Entry found',true);
    }
  } catch(err){setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false);}
}

async function fdbWriteByHash() {
  const{mac,vlanId,vlanV,port}=fdbInputs();
  setRegStatus('rv-st-fdb-cmd','Writing...',false);
  try{const{mac0,mac1}=fdbEncodeMac(mac);await fdbWr(FDB_OFF.MCU_MAC0,mac0);await fdbWr(FDB_OFF.MCU_MAC1,mac1);await fdbWr(FDB_OFF.MCU_VLAN,(vlanV?0x1000:0)|vlanId);await fdbWr(FDB_OFF.MCU_PORT,port);await fdbWr(FDB_OFF.MCU_CMD,FDB_CMD.HASH_WRITE);await fdbPoll(FDB_OFF.CMD_STATUS,0x4,500);setRegStatus('rv-st-fdb-cmd','Write OK',true);}
  catch(err){setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false);}
}

async function fdbWriteByBucket() {
  const{mac,vlanId,vlanV,port,bucket,slot}=fdbInputs();
  setRegStatus('rv-st-fdb-cmd','Writing...',false);
  try{const{mac0,mac1}=fdbEncodeMac(mac);await fdbWr(FDB_OFF.MCU_MAC0,mac0);await fdbWr(FDB_OFF.MCU_MAC1,mac1);await fdbWr(FDB_OFF.MCU_VLAN,(vlanV?0x1000:0)|vlanId);await fdbWr(FDB_OFF.MCU_PORT,port);await fdbWr(FDB_OFF.MCU_BUCKET,((slot&0xF)<<16)|(bucket&0x3FF));await fdbWr(FDB_OFF.MCU_CMD,FDB_CMD.WRITE_BUCKET);await fdbPoll(FDB_OFF.CMD_STATUS,0x4,500);setRegStatus('rv-st-fdb-cmd',`Write OK  Bkt:${bucket} Slot:0x${slot.toString(16)}`,true);}
  catch(err){setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false);}
}

async function fdbDeleteByHash() {
  const{mac,vlanId,vlanV}=fdbInputs();
  if(!confirm(`Delete FDB entry for ${mac}?`))return;
  setRegStatus('rv-st-fdb-cmd','Deleting...',false);
  try{const{mac0,mac1}=fdbEncodeMac(mac);await fdbWr(FDB_OFF.MCU_MAC0,mac0);await fdbWr(FDB_OFF.MCU_MAC1,mac1);await fdbWr(FDB_OFF.MCU_VLAN,(vlanV?0x1000:0)|vlanId);await fdbWr(FDB_OFF.MCU_CMD,FDB_CMD.HASH_DELETE);await fdbPoll(FDB_OFF.CMD_STATUS,0x4,500);fdbClearRows();setRegStatus('rv-st-fdb-cmd',`Deleted (${mac})`,true);}
  catch(err){setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false);}
}

async function fdbInitAll() {
  if(!confirm('Init all FDB tables?'))return;
  setRegStatus('rv-st-fdb-cmd','Flushing...',false);
  try{await fdbWr(FDB_OFF.MCU_CMD,FDB_CMD.FLUSH_ALL);await fdbPoll(FDB_OFF.FDB_STATUS,0x1,2000);fdbClearRows();setRegStatus('rv-st-fdb-cmd','Flush All done',true);}
  catch(err){setRegStatus('rv-st-fdb-cmd',`Error: ${err.message}`,false);}
}

async function fdbCtrlReadConfig() {
  setRegStatus('rv-st-fdb-ctrl','Reading...',false);
  try{
    const ver=await fdbReg(FDB_OFF.VERSION);if($('rv-fdb-ver'))$('rv-fdb-ver').value=`0x${ver.toString(16).toUpperCase().padStart(8,'0')}`;
    const en=await fdbReg(FDB_OFF.ENABLE);if($('rv-fdb-age-scan'))$('rv-fdb-age-scan').checked=(en&(1<<4))!==0;if($('rv-fdb-learning'))$('rv-fdb-learning').checked=(en&(1<<1))!==0;if($('rv-fdb-lookup'))$('rv-fdb-lookup').checked=(en&1)!==0;
    const ap=await fdbReg(FDB_OFF.AGE_PERIOD),at=await fdbReg(FDB_OFF.AGING_THR);if($('rv-fdb-age-period'))$('rv-fdb-age-period').value=ap;if($('rv-fdb-aging-thr'))$('rv-fdb-aging-thr').value=at;
    setRegStatus('rv-st-fdb-ctrl','Read OK',true);
  }catch(err){setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false);}
}

async function fdbCtrlApplyEnable() {
  let en=0;if($('rv-fdb-age-scan')?.checked)en|=(1<<4);if($('rv-fdb-learning')?.checked)en|=(1<<1);if($('rv-fdb-lookup')?.checked)en|=1;
  setRegStatus('rv-st-fdb-ctrl','Applying...',false);
  try{await fdbWr(FDB_OFF.ENABLE,en);setRegStatus('rv-st-fdb-ctrl','ENABLE applied',true);}
  catch(err){setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false);}
}

async function fdbCtrlLoadDefault() {
  setRegStatus('rv-st-fdb-ctrl','Loading...',false);
  try{await fdbWr(FDB_OFF.FDB_LOAD,1);setRegStatus('rv-st-fdb-ctrl','Default Load OK',true);}
  catch(err){setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false);}
}

// ── INTERRUPT ─────────────────────────────────────────────────────────────────
let _intrPollTimer = null;

function initIntrDots() {
  const portDiv=$('rv-intr-port-dots'), mdioDiv=$('rv-intr-mdio-dots'), pmDiv=$('rv-intr-port-mask'), mmDiv=$('rv-intr-mdio-mask');
  if(portDiv&&!portDiv.children.length)for(let i=0;i<16;i++)portDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;"><span id="rv-intr-p${i}" class="led-dot"></span>P${i}</span>`);
  if(mdioDiv&&!mdioDiv.children.length)for(let i=0;i<8;i++)mdioDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;"><span id="rv-intr-m${i}" class="led-dot"></span>M${i}</span>`);
  if(pmDiv&&!pmDiv.children.length)for(let i=0;i<16;i++)pmDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-intr-pm${i}" type="checkbox"><span>P${i}</span></label>`);
  if(mmDiv&&!mmDiv.children.length)for(let i=0;i<8;i++)mmDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-intr-mm${i}" type="checkbox"><span>M${i}</span></label>`);
}

async function intrCtrlRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x010'})});const v=parseRegD(d);const low=(v&1)!==0;if($('rv-intr-act-high'))$('rv-intr-act-high').checked=!low;if($('rv-intr-act-low'))$('rv-intr-act-low').checked=low;setRegStatus('rv-st-intr-ctrl',`OK — Active ${low?'Low':'High'}`,true);}
  catch(err){setRegStatus('rv-st-intr-ctrl',`Error: ${err.message}`,false);}
}

async function intrCtrlApply() {
  const low=$('rv-intr-act-low')?.checked?1:0;
  await rvWrite('0x010',`0x${low.toString(16).padStart(8,'0')}`,'rv-st-intr-ctrl');
}

async function intrRawRead() {
  try{
    const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x014'})});const v=parseRegD(d);
    for(let i=0;i<16;i++){const dot=$(`rv-intr-p${i}`);if(dot)dot.classList.toggle('connected',((v>>i)&1)!==0);}
    for(let i=0;i<8;i++){const dot=$(`rv-intr-m${i}`);if(dot)dot.classList.toggle('connected',((v>>(16+i))&1)!==0);}
    const swDot=$('rv-intr-sw-dot');if(swDot)swDot.classList.toggle('connected',((v>>>31)&1)!==0);
    setRegStatus('rv-st-intr-raw',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,true);
  }catch(err){setRegStatus('rv-st-intr-raw',`Error: ${err.message}`,false);}
}

function intrTogglePoll() {
  const btn=$('rv-intr-raw-poll');
  if(_intrPollTimer){clearInterval(_intrPollTimer);_intrPollTimer=null;if(btn){btn.textContent='▶ Poll';btn.className='small';}}
  else{_intrPollTimer=setInterval(intrRawRead,500);if(btn){btn.textContent='■ Stop';btn.className='small danger';}intrRawRead();}
}

async function intrMaskRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x018'})});const v=parseRegD(d);for(let i=0;i<16;i++){const c=$(`rv-intr-pm${i}`);if(c)c.checked=((v>>i)&1)!==0;}for(let i=0;i<8;i++){const c=$(`rv-intr-mm${i}`);if(c)c.checked=((v>>(16+i))&1)!==0;}const sw=$('rv-intr-sw-mask');if(sw)sw.checked=((v>>>31)&1)!==0;setRegStatus('rv-st-intr-mask','OK',true);}
  catch(err){setRegStatus('rv-st-intr-mask',`Error: ${err.message}`,false);}
}

async function intrMaskApply() {
  let v=0;for(let i=0;i<16;i++){if($(`rv-intr-pm${i}`)?.checked)v|=(1<<i);}for(let i=0;i<8;i++){if($(`rv-intr-mm${i}`)?.checked)v|=(1<<(16+i));}if($('rv-intr-sw-mask')?.checked)v|=0x80000000;
  await rvWrite('0x018',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-intr-mask');
}

async function intrSwTrigger() {
  setRegStatus('rv-st-intr-sw','Triggering...',true);
  try{await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x01C',value:'0x00000001'})});setRegStatus('rv-st-intr-sw','SW Trigger OK',true);const btn=$('rv-intr-sw-trigger');if(btn){btn.className='small primary';setTimeout(()=>{btn.className='small danger';},600);}}
  catch(err){setRegStatus('rv-st-intr-sw',`Error: ${err.message}`,false);}
}

// ── TIMESTAMP ─────────────────────────────────────────────────────────────────
async function tsReadTime() {
  setRegStatus('rv-st-ts','Reading...',true);
  try{
    const dNs=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x020'})}),dSecLo=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x024'})}),dSecHi=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x028'})});
    const ns=parseRegD(dNs),secLo=parseRegD(dSecLo),secHi=parseRegD(dSecHi);
    const sec=BigInt(secHi&0xFFFF)*4294967296n+BigInt(secLo>>>0);
    const dt=new Date(Number(sec)*1000);
    if($('rv-ts-current'))$('rv-ts-current').value=`${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}  ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}.${String(ns).padStart(9,'0')} ns`;
    setRegStatus('rv-st-ts','OK',true);
  }catch(err){setRegStatus('rv-st-ts',`Error: ${err.message}`,false);}
}

function tsSetNow() {
  const now=new Date();
  if($('rv-ts-year'))$('rv-ts-year').value=now.getFullYear();if($('rv-ts-month'))$('rv-ts-month').value=now.getMonth()+1;if($('rv-ts-day'))$('rv-ts-day').value=now.getDate();
  if($('rv-ts-hour'))$('rv-ts-hour').value=now.getHours();if($('rv-ts-min'))$('rv-ts-min').value=now.getMinutes();if($('rv-ts-sec'))$('rv-ts-sec').value=now.getSeconds();if($('rv-ts-set-ns'))$('rv-ts-set-ns').value=0;
}

async function tsSetTime() {
  setRegStatus('rv-st-ts','Setting...',true);
  try{
    const yr=parseInt($('rv-ts-year')?.value||'2025'),mo=parseInt($('rv-ts-month')?.value||'1'),dy=parseInt($('rv-ts-day')?.value||'1'),hr=parseInt($('rv-ts-hour')?.value||'0'),mn=parseInt($('rv-ts-min')?.value||'0'),sc=parseInt($('rv-ts-sec')?.value||'0'),ns=parseInt($('rv-ts-set-ns')?.value||'0')>>>0;
    const unixSec=BigInt(Math.floor(new Date(yr,mo-1,dy,hr,mn,sc).getTime()/1000));
    const secLo=Number(unixSec&0xFFFFFFFFn)>>>0,secHi=Number((unixSec>>32n)&0xFFFFn)>>>0;
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x020',value:`0x${ns.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x024',value:`0x${secLo.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x028',value:`0x${secHi.toString(16).padStart(8,'0')}`})});
    setRegStatus('rv-st-ts','Time set OK',true);
  }catch(err){setRegStatus('rv-st-ts',`Error: ${err.message}`,false);}
}

async function tsReadClock() {
  setRegStatus('rv-st-ts-clk','Reading...',true);
  try{
    const dA=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x02C'})}),dC1=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});
    const addend=parseRegD(dA),ctrl1=parseRegD(dC1),increment=ctrl1&0xFFFF;
    const scaled=increment+addend/4294967296.0,nsPerTick=scaled*1e9/4294967296.0,mhz=nsPerTick>0?Math.round(1000.0/nsPerTick*1e6)/1e6:0;
    if($('rv-ts-clk-mhz'))$('rv-ts-clk-mhz').value=mhz;
    setRegStatus('rv-st-ts-clk',`INCREMENT=${increment}  ADDEND=0x${addend.toString(16).toUpperCase().padStart(8,'0')}`,true);
  }catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsApplyClock() {
  const mhz=parseFloat($('rv-ts-clk-mhz')?.value||'200');if(!mhz){setRegStatus('rv-st-ts-clk','Invalid MHz',false);return;}
  setRegStatus('rv-st-ts-clk','Setting...',true);
  try{
    const periodNs=1000.0/mhz,exactIncr=periodNs*4294967296.0/1e9,increment=Math.floor(exactIncr)>>>0,addend=Math.round((exactIncr-increment)*4294967296.0)>>>0;
    const dC1=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});let ctrl1=parseRegD(dC1)&0xFFFF0000;ctrl1|=(increment&0xFFFF);
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x02C',value:`0x${addend.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x030',value:`0x${ctrl1.toString(16).padStart(8,'0')}`})});
    setRegStatus('rv-st-ts-clk',`OK INCREMENT=${increment}`,true);
  }catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsReadPps() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});const v=parseRegD(d),src=(v>>16)&0x3,wid=((v>>24)&0xFF)*2;document.querySelectorAll('input[name="ts-pps-src"]').forEach(r=>{r.checked=parseInt(r.value)===(src>=2?2:src);});if($('rv-ts-pps-width'))$('rv-ts-pps-width').value=wid;const srcLabel=['Disable','Internal','GPS'][src]||'GPS';setRegStatus('rv-st-ts-clk',`PPS: ${srcLabel}  width=${wid}ms`,true);}
  catch(err){setRegStatus('rv-st-ts-clk',`PPS read error: ${err.message}`,false);}
}

async function tsApplyPps() {
  try{const src=parseInt(document.querySelector('input[name="ts-pps-src"]:checked')?.value||'1'),wid=parseInt($('rv-ts-pps-width')?.value||'100');const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});let v=parseRegD(d)&~0xFF030000;v|=(src&0x3)<<16;v|=((Math.floor(wid/2)&0xFF)<<24);await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x030',value:`0x${v.toString(16).padStart(8,'0')}`})});setRegStatus('rv-st-ts-clk','PPS set OK',true);}
  catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsAdjNs(inc) {
  const ms=parseInt($('rv-ts-ns-adj')?.value||'0'),nsV=(Math.abs(ms)*1000000)>>>0,v=(nsV&0x3FFFFFFF)|(inc?0x40000000:0x80000000);
  await rvWrite('0x034',`0x${v.toString(16).padStart(8,'0')}`,'rv-st-ts-adj');
}

async function tsAdjSec(inc) {
  const s=parseInt($('rv-ts-sec-adj')?.value||'0'),v=(Math.abs(s)&0x3FFFFFFF)|(inc?0x40000000:0x80000000);
  await rvWrite('0x038',`0x${v.toString(16).padStart(8,'0')}`,'rv-st-ts-adj');
}

// ── LED / CLOCK ───────────────────────────────────────────────────────────────
const LED_FPGA_LABELS=['System CLK Blink(400M)','AHB CLK Blink(400M)','RGMII CLK Blink(125M)','Reset_n','EXT_SW[0]','EXT_SW[1]','EXT_SW[2]','EXT_SW[3]'];

function initLedDots() {
  const fpgaDiv=$('rv-led-fpga-dots'),regDiv=$('rv-led-reg-chks'),swDiv=$('rv-ext-sw-dots');
  if(fpgaDiv&&!fpgaDiv.children.length)LED_FPGA_LABELS.forEach((lbl,i)=>fpgaDiv.insertAdjacentHTML('beforeend',`<div style="display:flex;align-items:center;gap:4px;font-size:11px;margin:1px 0;"><span id="rv-led-fpga-${i}" class="led-dot"></span>${esc(lbl)}</div>`));
  if(regDiv&&!regDiv.children.length)for(let i=0;i<8;i++)regDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-led-rb-${i}" type="checkbox"><span>LED${i}</span></label>`);
  if(swDiv&&!swDiv.children.length)for(let i=0;i<6;i++)swDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;"><span id="rv-ext-sw-${i}" class="led-dot"></span>SW${i}</span>`);
}

function ledModeChanged() {
  const mode=parseInt(document.querySelector('input[name="led-mode"]:checked')?.value??'1');
  const fpgaDiv=$('rv-led-fpga-dots'),regDiv=$('rv-led-reg-chks'),cpuWarn=$('rv-led-cpu-warn'),applyReg=$('rv-led-apply-reg');
  if(fpgaDiv)fpgaDiv.style.display=mode===1?'':'none';if(regDiv)regDiv.style.display=mode===3?'':'none';if(cpuWarn)cpuWarn.style.display=mode===0?'':'none';if(applyReg)applyReg.style.display=mode===3?'':'none';
}

async function ledRead() {
  setRegStatus('rv-st-led','Reading...',true);
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x060'})});const v=parseRegD(d),mode=(v>>8)&0x3,leds=v&0xFF;document.querySelectorAll('input[name="led-mode"]').forEach(r=>{r.checked=parseInt(r.value)===mode;});for(let i=0;i<8;i++){const on=((leds>>i)&1)!==0;const fpgaDot=$(`rv-led-fpga-${i}`);if(fpgaDot)fpgaDot.classList.toggle('connected',on);const regChk=$(`rv-led-rb-${i}`);if(regChk)regChk.checked=on;}ledModeChanged();setRegStatus('rv-st-led',`OK — mode=${mode}  leds=0x${leds.toString(16).padStart(2,'0').toUpperCase()}`,true);}
  catch(err){setRegStatus('rv-st-led',`Error: ${err.message}`,false);}
}

async function ledApplyMode() {
  const mode=parseInt(document.querySelector('input[name="led-mode"]:checked')?.value??'1');
  setRegStatus('rv-st-led','Setting...',true);
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x060'})});let v=parseRegD(d)&~0x300;v|=(mode<<8);await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x060',value:`0x${v.toString(16).padStart(8,'0')}`})});ledModeChanged();setRegStatus('rv-st-led','LED mode set',true);}
  catch(err){setRegStatus('rv-st-led',`Error: ${err.message}`,false);}
}

async function ledApplyReg() {
  let leds=0;for(let i=0;i<8;i++){if($(`rv-led-rb-${i}`)?.checked)leds|=(1<<i);}
  setRegStatus('rv-st-led','Setting...',true);
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x060'})});let v=parseRegD(d)&~0xFF;v|=leds;await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x060',value:`0x${v.toString(16).padStart(8,'0')}`})});setRegStatus('rv-st-led','LED output set',true);}
  catch(err){setRegStatus('rv-st-led',`Error: ${err.message}`,false);}
}

async function extSwRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x064'})});const v=parseRegD(d);for(let i=0;i<6;i++){const dot=$(`rv-ext-sw-${i}`);if(dot)dot.classList.toggle('connected',((v>>i)&1)!==0);}setRegStatus('rv-st-ext-sw',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,true);}
  catch(err){setRegStatus('rv-st-ext-sw',`Error: ${err.message}`,false);}
}

function clkLimitToMhz(limit){return limit>0?Math.round(limit*2/1e6*1e6)/1e6:0;}
function clkMhzToLimit(mhz){return Math.round(mhz*1e6/2)>>>0;}

async function clkRead() {
  setRegStatus('rv-st-clk-limit','Reading...',true);
  try{const[d0,d1,dr]=await Promise.all([api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x068'})}),api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x06C'})}),api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x0D0'})})]);if($('rv-clk-sys'))$('rv-clk-sys').value=clkLimitToMhz(parseRegD(d0));if($('rv-clk-ahb'))$('rv-clk-ahb').value=clkLimitToMhz(parseRegD(d1));if($('rv-clk-rgmii'))$('rv-clk-rgmii').value=clkLimitToMhz(parseRegD(dr));setRegStatus('rv-st-clk-limit','OK',true);}
  catch(err){setRegStatus('rv-st-clk-limit',`Error: ${err.message}`,false);}
}

async function clkApply(offset,inputId){const mhz=parseFloat($(inputId)?.value||'0');await rvWrite(offset,`0x${clkMhzToLimit(mhz).toString(16).padStart(8,'0')}`,'rv-st-clk-limit');}

// ── COUNT ─────────────────────────────────────────────────────────────────────
async function countRead() {
  const port=$('rv-count-port')?.value||'all';
  setRegStatus('rv-st-count','Reading...',true);
  try{
    const data=await api(`/api/counter/read?port=${encodeURIComponent(port)}`);
    const tbody=$('rv-count-tbody');if(!tbody)return;
    if(!data.counters||data.counters.length===0){tbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--muted);">No data — check serial connection</td></tr>';setRegStatus('rv-st-count','No data',false);return;}
    tbody.innerHTML=data.counters.map(c=>`<tr><td>${esc(c.name)}</td><td class="mono" style="font-size:11px;">${esc(c.address)}</td><td class="mono" style="font-size:11px;">${esc(c.value)}</td><td style="text-align:right;">${c.valueDec}</td></tr>`).join('');
    setRegStatus('rv-st-count',`${data.counters.length} counters  port: ${port==='all'?'ALL':`Port ${port}`}`,true);
  }catch(err){setRegStatus('rv-st-count',`Error: ${err.message}`,false);}
}

// ── MDIO ──────────────────────────────────────────────────────────────────────
const MDIO_PHY_ADDRS=[0x00,0x04,0x05,0x08,0x0A,0x0C];

function mdioPortChanged() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phy=MDIO_PHY_ADDRS[port]??0;
  if($('rv-mdio-phy-addr'))$('rv-mdio-phy-addr').value=`0x${phy.toString(16).toUpperCase().padStart(2,'0')}`;
}

function mdioCalcMdc() {
  const mhz=parseFloat($('rv-mdio-mhz')?.value||'2.5');if(isNaN(mhz)||mhz<=0){setRegStatus('rv-st-mdio','Invalid MHz',false);return;}
  const ahbMhz=100.0,clk=Math.max(1,Math.min(255,Math.round(ahbMhz/(2.0*mhz)))),ms=Math.max(1,Math.min(4095,Math.round(mhz*1000.0)));
  if($('rv-mdio-clk'))$('rv-mdio-clk').value=String(clk);if($('rv-mdio-ms'))$('rv-mdio-ms').value=String(ms);if($('rv-mdio-unit'))$('rv-mdio-unit').value='100';
  setRegStatus('rv-st-mdio',`f_MDC ≈ ${(ahbMhz/(2.0*clk)).toFixed(3)} MHz  (CLK=${clk}, MILLISEC=${ms})`,true);
}

async function mdioApplySetup() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),enable=$('rv-mdio-en')?.checked??false,preDisable=$('rv-mdio-predis')?.checked??false,intrEnable=$('rv-mdio-intr')?.checked??false,targetMhz=parseFloat($('rv-mdio-mhz')?.value||'2.5');
  setRegStatus('rv-st-mdio','Applying...',true);
  try{const data=await api('/api/mdio/setup',{method:'POST',body:JSON.stringify({port,enable,preDisable,interruptEnable:intrEnable,targetMhz})});setRegStatus('rv-st-mdio',`SETUP=0x${String(data.setup||'').replace(/^0x/i,'')}  CLK=${data.clk}`,true);}
  catch(err){setRegStatus('rv-st-mdio',`Error: ${err.message}`,false);}
}

async function mdioReadPhy() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phyAddr=$('rv-mdio-phy-addr')?.value||'0x00',regAddr=$('rv-mdio-reg-addr')?.value||'0x01';
  setRegStatus('rv-st-mdio-acc','Reading...',true);
  try{const data=await api('/api/mdio/read',{method:'POST',body:JSON.stringify({port,phyAddr,regAddr})});if($('rv-mdio-acc-data'))$('rv-mdio-acc-data').value=data.value||'0x0000';setRegStatus('rv-st-mdio-acc',`PHY[${phyAddr}] Reg[${regAddr}] = ${data.value}`,true);}
  catch(err){setRegStatus('rv-st-mdio-acc',`Error: ${err.message}`,false);}
}

async function mdioWritePhy() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phyAddr=$('rv-mdio-phy-addr')?.value||'0x00',regAddr=$('rv-mdio-reg-addr')?.value||'0x01',value=$('rv-mdio-acc-data')?.value||'0x0000';
  setRegStatus('rv-st-mdio-acc','Writing...',true);
  try{await api('/api/mdio/write',{method:'POST',body:JSON.stringify({port,phyAddr,regAddr,value})});setRegStatus('rv-st-mdio-acc',`PHY[${phyAddr}] Reg[${regAddr}] ← ${value} OK`,true);}
  catch(err){setRegStatus('rv-st-mdio-acc',`Error: ${err.message}`,false);}
}

async function mdioReadAllLink() {
  setRegStatus('rv-st-mdio-link','Reading...',true);
  try{const data=await api('/api/mdio/link-status');if(data.ports){data.ports.forEach(p=>{const td=$(`rv-mdio-link-${p.port}`);if(!td)return;const linked=p.linkUp===true,label=p.linkUp===null?'—':(p.linkUp?'Link UP':'Link DOWN');td.innerHTML=`<span class="led-dot${linked?' connected':''}"></span> ${label}`;});}setRegStatus('rv-st-mdio-link',`Updated ${new Date().toLocaleTimeString()}`,true);}
  catch(err){setRegStatus('rv-st-mdio-link',`Error: ${err.message}`,false);}
}

function initRegViewer() {
  const rc=$('regContent');if(!rc)return;

  rc.addEventListener('click', async e => {
    const btn=e.target.closest('[data-rw]');if(!btn)return;
    const rw=btn.dataset.rw,valId=btn.dataset.val,stId=btn.dataset.st,offset=btn.dataset.offVal||(btn.dataset.off?$(btn.dataset.off)?.value||btn.dataset.off:null);
    if(!offset)return;
    try{if(rw==='read'){await rvRead(offset,valId,stId);}else{const val=valId&&$(valId)?$(valId).value:'0x00000000';await rvWrite(offset,val,stId);}}catch{/* status already set */}
  });

  $('rv-ver-read')?.addEventListener('click',async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x000'})});const v=parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0;if($('rv-ver-str'))$('rv-ver-str').value=parseSysCtrlVersion(v);setRegStatus('rv-st-version','OK',true);}catch(err){setRegStatus('rv-st-version',`Error: ${err.message}`,false);}});
  $('rv-ver-default')?.addEventListener('click',async()=>{await rvWrite('0x004','0x00000001','rv-st-version');});
  $('rv-en-read')?.addEventListener('click',async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x008'})});syncSysCtrlEnable(parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0);setRegStatus('rv-st-enable','OK',true);}catch(err){setRegStatus('rv-st-enable',`Error: ${err.message}`,false);}});
  $('rv-en-apply')?.addEventListener('click',async()=>{await rvWrite('0x008',`0x${buildSysCtrlEnable().toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-enable');});
  $('rv-ahb-read')?.addEventListener('click',async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x00C'})});syncHostIf(parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0);setRegStatus('rv-st-ahb','OK',true);}catch(err){setRegStatus('rv-st-ahb',`Error: ${err.message}`,false);}});
  $('rv-ahb-apply')?.addEventListener('click',async()=>{await rvWrite('0x00C',`0x${buildHostIf().toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-ahb');});
  $('sysctlReadAll')?.addEventListener('click',()=>{$('rv-ver-read')?.click();$('rv-en-read')?.click();$('rv-ahb-read')?.click();});

  initIntrDots();
  $('interruptReadAll')?.addEventListener('click',()=>Promise.allSettled([intrCtrlRead(),intrRawRead(),intrMaskRead()]));
  $('rv-intr-ctrl-read')?.addEventListener('click',intrCtrlRead);$('rv-intr-ctrl-apply')?.addEventListener('click',intrCtrlApply);
  $('rv-intr-raw-read')?.addEventListener('click',intrRawRead);$('rv-intr-raw-poll')?.addEventListener('click',intrTogglePoll);
  $('rv-intr-mask-read')?.addEventListener('click',intrMaskRead);$('rv-intr-mask-apply')?.addEventListener('click',intrMaskApply);
  $('rv-intr-sw-trigger')?.addEventListener('click',intrSwTrigger);

  $('timestampReadAll')?.addEventListener('click',()=>Promise.allSettled([tsReadTime(),tsReadClock(),tsReadPps()]));
  $('rv-ts-read-time')?.addEventListener('click',tsReadTime);$('rv-ts-now')?.addEventListener('click',tsSetNow);$('rv-ts-set-time')?.addEventListener('click',tsSetTime);
  $('rv-ts-read-clock')?.addEventListener('click',tsReadClock);$('rv-ts-apply-clock')?.addEventListener('click',tsApplyClock);
  $('rv-ts-read-pps')?.addEventListener('click',tsReadPps);$('rv-ts-apply-pps')?.addEventListener('click',tsApplyPps);
  $('rv-ts-ns-inc')?.addEventListener('click',()=>tsAdjNs(true));$('rv-ts-ns-dec')?.addEventListener('click',()=>tsAdjNs(false));
  $('rv-ts-sec-inc')?.addEventListener('click',()=>tsAdjSec(true));$('rv-ts-sec-dec')?.addEventListener('click',()=>tsAdjSec(false));

  initLedDots();
  document.querySelectorAll('input[name="led-mode"]').forEach(r=>r.addEventListener('change',ledModeChanged));
  $('ledclockReadAll')?.addEventListener('click',()=>Promise.allSettled([ledRead(),extSwRead(),clkRead()]));
  $('rv-led-read')?.addEventListener('click',ledRead);$('rv-led-apply-mode')?.addEventListener('click',ledApplyMode);$('rv-led-apply-reg')?.addEventListener('click',ledApplyReg);
  $('rv-ext-sw-read')?.addEventListener('click',extSwRead);$('rv-clk-read')?.addEventListener('click',clkRead);
  $('rv-clk-sys-apply')?.addEventListener('click',()=>clkApply('0x068','rv-clk-sys'));$('rv-clk-ahb-apply')?.addEventListener('click',()=>clkApply('0x06C','rv-clk-ahb'));$('rv-clk-rgmii-apply')?.addEventListener('click',()=>clkApply('0x0D0','rv-clk-rgmii'));
  $('rv-clk-apply-all')?.addEventListener('click',()=>Promise.allSettled([clkApply('0x068','rv-clk-sys'),clkApply('0x06C','rv-clk-ahb'),clkApply('0x0D0','rv-clk-rgmii')]));

  const TD_OFFSETS=['0x040','0x044','0x048','0x04C','0x050','0x054','0x058','0x05C'];
  $('testdataReadAll')?.addEventListener('click',()=>Promise.allSettled(TD_OFFSETS.map((off,i)=>rvRead(off,`rv-td-${i}`,`rv-st-td-${i}`))));
  $('testdataWriteAll')?.addEventListener('click',()=>Promise.allSettled(TD_OFFSETS.map((off,i)=>rvWrite(off,$(`rv-td-${i}`)?.value||'0x00000000',`rv-st-td-${i}`))));

  $('rv-count-read')?.addEventListener('click',countRead);
  $('rv-count-clear')?.addEventListener('click',()=>{const tbody=$('rv-count-tbody');if(tbody)tbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--muted);">No data</td></tr>';setRegStatus('rv-st-count','',true);});

  $('rv-mdio-port')?.addEventListener('change',mdioPortChanged);$('rv-mdio-calc')?.addEventListener('click',mdioCalcMdc);$('rv-mdio-apply')?.addEventListener('click',mdioApplySetup);$('rv-mdio-read-phy')?.addEventListener('click',mdioReadPhy);$('rv-mdio-write-phy')?.addEventListener('click',mdioWritePhy);$('rv-mdio-read-link')?.addEventListener('click',mdioReadAllLink);

  $('rv-fdb-port-mac')?.addEventListener('change',e=>{const val=e.target.value;if(!val)return;const[portIdx,mac]=val.split('|');if($('rv-fdb-mac'))$('rv-fdb-mac').value=mac;if($('rv-fdb-port'))$('rv-fdb-port').value=portIdx;});
  $('rv-fdb-read-config')?.addEventListener('click',fdbCtrlReadConfig);$('fdbReadConfig')?.addEventListener('click',fdbCtrlReadConfig);
  $('rv-fdb-apply-en')?.addEventListener('click',fdbCtrlApplyEnable);$('rv-fdb-load-default')?.addEventListener('click',fdbCtrlLoadDefault);
  $('rv-fdb-rdhash')?.addEventListener('click',fdbReadByHash);$('rv-fdb-rdbucket')?.addEventListener('click',fdbReadByBucket);
  $('rv-fdb-wrhash')?.addEventListener('click',fdbWriteByHash);$('rv-fdb-wrbucket')?.addEventListener('click',fdbWriteByBucket);
  $('rv-fdb-delete')?.addEventListener('click',fdbDeleteByHash);$('rv-fdb-initall')?.addEventListener('click',fdbInitAll);

  $('regBaseAddr')?.addEventListener('keydown',async function(e){if(e.key!=='Enter')return;e.preventDefault();const val=this.value.trim();if(!val)return;try{await api('/api/register/base-addr',{method:'POST',body:JSON.stringify({address:val})});}catch{/*worker mode*/}await refreshRegStatus();});
  $('regBaseAddr')?.addEventListener('blur',async function(){const val=this.value.trim();if(!val)return;try{await api('/api/register/base-addr',{method:'POST',body:JSON.stringify({address:val})});}catch{/*worker mode*/}});
}

// ── TOC Navigation ────────────────────────────────────────────────────────────
function initTocNav() {
  document.querySelectorAll('[data-sec]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sec]').forEach(b => b.classList.remove('toc-active'));
      btn.classList.add('toc-active');
      const target = document.getElementById(`rsec-${btn.dataset.sec}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ── Layout Toggle & Splitter ──────────────────────────────────────────────────
function initLayoutToggle() {
  const btn=$('layoutToggle'),wrap=$('hyperContent');if(!btn||!wrap)return;
  let vert=false; // default: horizontal (terminal on right)
  btn.textContent='⊞'; btn.title='Vertical layout';
  btn.addEventListener('click',()=>{
    vert=!vert;
    wrap.classList.toggle('vertical',vert);
    btn.textContent=vert?'⊟':'⊞';
    btn.title=vert?'Horizontal layout':'Vertical layout';
  });
}

function initSplitter() {
  const splitter=$('hyperSplitter'),wrap=$('hyperContent'),terminal=document.querySelector('.hyper-terminal');
  if(!splitter||!wrap||!terminal)return;
  let dragging=false,startPos=0,startSize=0;
  splitter.addEventListener('mousedown',e=>{
    dragging=true;
    const isVert=wrap.classList.contains('vertical');
    startPos=isVert?e.clientY:e.clientX;
    startSize=isVert?terminal.offsetHeight:terminal.offsetWidth;
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const isVert=wrap.classList.contains('vertical');
    const delta=(isVert?e.clientY:e.clientX)-startPos;
    const size=Math.max(80,startSize-delta);
    terminal.style[isVert?'height':'width']=`${size}px`;
  });
  document.addEventListener('mouseup',()=>{dragging=false;});
}

// ── HyperTerminal (Serial) ────────────────────────────────────────────────────
function updateSerialUI(connected, statusText) {
  state.serialConnected = connected;
  updateStatusBar();
  const led=$('serialLed'),st=$('serialState');
  if(led)led.classList.toggle('connected',connected);
  const connectBtn=$('serialConnect'),disconnectBtn=$('serialDisconnect');
  if(connectBtn){connectBtn.disabled=connected;connectBtn.style.opacity=connected?'.5':'1';}
  if(disconnectBtn){disconnectBtn.disabled=!connected;disconnectBtn.style.opacity=connected?'1':'.5';}
  if(st&&statusText!==undefined)st.textContent=statusText;
  const brk=$('serialBrk');if(brk)brk.disabled=!connected;
}

function appendHyperTerm(text) {
  const now=new Date(),ts=`[${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3,'0')}]`;
  const line=`${ts}  ${text}\n`;
  const out=$('serialOutput');
  if(out){if(out.textContent==='No terminal output.')out.textContent='';out.textContent+=line;out.scrollTop=out.scrollHeight;}
  const seq=$('seqTerminal');
  if(seq){if(seq.textContent==='No output.')seq.textContent='';seq.textContent+=line;seq.scrollTop=seq.scrollHeight;}
}

let _ttyStreamCtrl=null;
function startTtyStream(session) {
  if(_ttyStreamCtrl)_ttyStreamCtrl.abort();
  _ttyStreamCtrl=new AbortController();
  const url=`/api/tty/stream${session?`?session=${encodeURIComponent(session)}`:''}`;
  let buf='';
  fetch(url,{signal:_ttyStreamCtrl.signal}).then(r=>{
    const reader=r.body.getReader(),decoder=new TextDecoder();
    function read(){reader.read().then(({done,value})=>{if(done)return;buf+=decoder.decode(value,{stream:true});const parts=buf.split('\n');buf=parts.pop()??'';for(const part of parts){const s=part.trim();if(!s)continue;try{const msg=JSON.parse(s);if(msg.type==='rx'&&msg.hex){const bytes=Uint8Array.from(msg.hex.match(/.{1,2}/g)||[],b=>parseInt(b,16));const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);text.split(/\r?\n/).filter(l=>l.trim()).forEach(l=>appendHyperTerm(l));}else if(msg.type==='closed'){updateSerialUI(false,'disconnected');stopTtyStream();}else if(msg.type==='error'){appendHyperTerm(`[ERR] ${msg.message}`);}}catch{/*ignore*/}}read();}).catch(()=>{});}read();}).catch(()=>{});
}

function stopTtyStream() { if(_ttyStreamCtrl){_ttyStreamCtrl.abort();_ttyStreamCtrl=null;} }

async function refreshSerialStatus() {
  try {
    const data=await api('/api/serial/status');
    const t=data.terminal||{};
    const ttys=data.ttys||data.ports||t.ports||[];
    const portSel=$('serialPort');
    if(portSel){
      const cur=portSel.value||t.selectedPort||data.session||'';
      portSel.innerHTML=ttys.map(p=>{const val=p.path||p.portName||p.PortName||p.name||String(p),label=p.manufacturer?`${val}  (${p.manufacturer})`:(p.displayName||p.DisplayName||p.usbProduct||val);return `<option value="${esc(val)}">${esc(label)}</option>`;}).join('');
      if(!portSel.innerHTML)portSel.innerHTML='<option value="">-- No ports --</option>';
      if(cur&&portSel.querySelector(`option[value="${cur}"]`))portSel.value=cur;
    }
    const baudSel=$('serialBaud');
    if(baudSel){
      const cur=baudSel.value||String(t.selectedBaudRate||115200);
      const rates=t.baudRates||[9600,19200,38400,57600,115200,230400,921600];
      if(!baudSel.options.length||(t.baudRates&&baudSel.options.length!==rates.length))baudSel.innerHTML=rates.map(b=>`<option value="${b}">${b}</option>`).join('');
      baudSel.value=t.selectedBaudRate?String(t.selectedBaudRate):cur;
    }
    const connected=!!(data.open||data.connected||t.isConnected);
    const statusTxt=t.connectionStatus||(connected?`connected (${data.session||''})`:' disconnected');
    updateSerialUI(connected,statusTxt);
    const out=$('serialOutput');
    if(out&&t.terminalOutput!==undefined){out.textContent=t.terminalOutput||'No terminal output.';out.scrollTop=out.scrollHeight;}
  } catch { updateSerialUI(false,'offline'); }
}

async function toggleSerial(connect) {
  if(connect===false||state.serialConnected) {
    stopTtyStream();
    try{await api('/api/serial/disconnect',{method:'POST',body:'{}'});toast('Serial disconnected','ok');}catch(err){toast(`Disconnect failed: ${err.message}`,'bad');}
  } else {
    const port=$('serialPort')?.value,baud=Number($('serialBaud')?.value)||115200;
    if(!port){toast('Select a port first','warn');return;}
    try{const res=await api('/api/serial/connect',{method:'POST',body:JSON.stringify({port,baudRate:baud,path:port})});if(!res?.terminal)startTtyStream(res?.session||res?.sessionId||port);toast(`Connected: ${port} @ ${baud} bps`,'ok');}
    catch(err){toast(`Serial error: ${err.message}`,'bad');}
  }
  await refreshSerialStatus();
}

async function sendSerial() {
  const inp=$('serialInput');if(!inp?.value.trim())return;
  const text=inp.value+'\r\n';
  try{await api('/api/serial/send',{method:'POST',body:JSON.stringify({text})});appendHyperTerm(`> ${inp.value}`);inp.value='';}
  catch(err){toast(`Send failed: ${err.message}`,'bad');}
}

// ── Logs ──────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try{
    const data=await api('/api/logs');const box=$('logsBox');if(!box)return;
    const fmtEntry=(e,kind)=>{if(e.error)return `[${kind}] parse error: ${e.file}\n`;const ts=e.startedAt||e.timestamp||e.createdAt||'',name=e.name||e.testName||e.macroName||e.id||'?',result=e.result||e.status||(e.passed!=null?(e.passed?'PASS':'FAIL'):'');return `${ts?new Date(ts).toLocaleString()+'  '  :''}[${kind}] ${name}  ${result}\n`;};
    const tests=(data.tests||[]).map(e=>fmtEntry(e,'TEST')),macros=(data.macros||[]).map(e=>fmtEntry(e,'MACRO'));
    const all=[...tests,...macros];box.textContent=all.length?all.join(''):  '(no logs yet)';
  }catch(err){if($('logsBox'))$('logsBox').textContent=`Log load failed: ${err.message}`;}
}

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar() {
  const pkts=state.captureRows.length;
  const serial=state.serialConnected?'● Serial':'○ Serial';
  const cap=state.captureTimer?`● Cap ${pkts}pkts`:`○ Cap ${pkts}pkts`;
  const sb=$('statusExtra');if(sb)sb.textContent=`${serial}   ${cap}`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function initWebSocket() {
  const ws=new WebSocket(`ws://${location.host}`);
  ws.onmessage=({data})=>{try{const msg=JSON.parse(data);if(msg.type==='workerEvent'){const p=msg.payload||{};if(p.type==='serialData'||p.type==='terminal'){appendSeqTerm(p.text||p.data||'');}}}catch{/*ignore*/}};
  ws.onclose=()=>setTimeout(initWebSocket,3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();
  initWebSocket();
  initSplitter();
  initTocNav();
  initRegViewer();

  if($('startTime'))$('startTime').textContent=new Date().toLocaleTimeString();

  // Packet Generator
  $('refreshAll')?.addEventListener('click', refreshInterfaces);
  $('build')?.addEventListener('click', previewFrame);
  $('send')?.addEventListener('click', sendFrame);
  ['protocol','dstMac','srcMac','srcIp','dstIp','srcPort','dstPort','payload','vlanEnabled','vlanId','vlanPriority']
    .forEach(id=>$(id)?.addEventListener('change',previewFrame));

  // Capture
  $('captureRefresh')?.addEventListener('click', refreshCaptureStatus);
  $('captureStart')?.addEventListener('click', startCapture);
  $('captureStop')?.addEventListener('click', stopCapture);
  $('captureClear')?.addEventListener('click', clearCapture);
  $('captureExportCsv')?.addEventListener('click', downloadCaptureCsv);
  $('captureFilter')?.addEventListener('input', renderCaptureRows);

  document.querySelectorAll('.proto-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.proto-chip').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const f=$('captureFilter');if(f){f.value=btn.dataset.proto||'';renderCaptureRows();}
    });
  });

  // Scenario Lab
  $('tcRefresh')?.addEventListener('click', loadTestCases);
  $('tcImportCsv')?.addEventListener('click', importCsvScenarios);
  $('tcAddGroup')?.addEventListener('click', addTcGroup);
  $('tcAdd')?.addEventListener('click', addTcFromCurrent);
  $('tcSaveCurrent')?.addEventListener('click', saveTcCurrent);
  // seqRun/seqStop/seqClear/seqLoad wired in initApp()
  $('seqLoad')?.addEventListener('click', loadSequence);
  $('seqTermSend')?.addEventListener('click', seqTermSend);
  $('seqTermInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')seqTermSend();});
  $('clearSeqTerminal')?.addEventListener('click', ()=>{if($('seqTerminal'))$('seqTerminal').textContent='';});

  // Event palette (inline editor)
  document.querySelectorAll('.palette-item[data-event]').forEach(el => {
    el.addEventListener('click', () => showEventEditor(el.dataset.event));
  });
  $('addToSequence')?.addEventListener('click', addEventFromEditor);

  // Modal events (keep for compatibility)
  $('evModalOk')?.addEventListener('click', confirmEventModal);
  $('evModalCancel')?.addEventListener('click', closeEventModal);
  $('evModalClose')?.addEventListener('click', closeEventModal);
  $('eventModal')?.addEventListener('click', e=>{if(e.target===$('eventModal'))closeEventModal();});
  document.addEventListener('keydown', e=>{if(e.key==='Escape'&&$('eventModal')?.style.display!=='none')closeEventModal();});

  // Register / FDB (Scenario Lab)
  $('regStatusRefresh')?.addEventListener('click', refreshRegStatus);
  $('regRead')?.addEventListener('click', readRegister);
  $('regWrite')?.addEventListener('click', writeRegister);
  $('fdbRead')?.addEventListener('click', ()=>fdbCall('/api/fdb/read'));
  $('fdbWrite')?.addEventListener('click', ()=>fdbCall('/api/fdb/write'));
  $('fdbDelete')?.addEventListener('click', ()=>fdbCall('/api/fdb/delete'));
  $('fdbFlush')?.addEventListener('click', ()=>{if(confirm('Flush all FDB entries?'))fdbCall('/api/fdb/flush',{});});

  // HyperTerminal
  $('serialRefresh')?.addEventListener('click', refreshSerialStatus);
  $('serialConnect')?.addEventListener('click', ()=>toggleSerial(true));
  $('serialDisconnect')?.addEventListener('click', ()=>toggleSerial(false));
  $('serialSend')?.addEventListener('click', sendSerial);
  $('serialInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')sendSerial();});
  $('serialClear')?.addEventListener('click', async ()=>{
    try{await api('/api/serial/clear',{method:'POST',body:'{}'});}catch{/*best effort*/}
    if($('serialOutput'))$('serialOutput').textContent='';
  });
  $('serialBrk')?.addEventListener('click', async ()=>{
    try{await api('/api/serial/brk',{method:'POST',body:'{}'});toast('BRK signal sent','ok');}
    catch(err){
      // fallback to /api/serial/break
      try{await api('/api/serial/break',{method:'POST',body:'{}'});toast('BRK signal sent','ok');}
      catch{toast(`BRK failed: ${err.message}`,'bad');}
    }
  });

  // Settings
  $('refreshLogs')?.addEventListener('click', loadLogs);
  $('settingsWorkerRefresh')?.addEventListener('click', async ()=>{
    try{const data=await api('/api/register/status');const el=$('settingsWorkerState');if(el)el.textContent=`${data.serialConnected?'● connected':'○ disconnected'}  base: ${data.baseAddress||'—'}`;if($('settingsBaseAddr')&&data.baseAddress)$('settingsBaseAddr').value=data.baseAddress;}
    catch(err){if($('settingsWorkerState'))$('settingsWorkerState').textContent=`offline: ${err.message}`;}
  });
  $('settingsBaseAddrApply')?.addEventListener('click', async ()=>{
    const val=$('settingsBaseAddr')?.value?.trim();if(!val)return;
    try{await api('/api/register/base-addr',{method:'POST',body:JSON.stringify({address:val})});if($('settingsBaseAddrSt'))$('settingsBaseAddrSt').textContent='Applied';setTimeout(()=>{if($('settingsBaseAddrSt'))$('settingsBaseAddrSt').textContent='';},2000);await refreshRegStatus();}
    catch(err){if($('settingsBaseAddrSt'))$('settingsBaseAddrSt').textContent=`Error: ${err.message}`;}
  });

  try {
    await api('/api/health');
    setStatus('Connected');
    await Promise.allSettled([
      refreshInterfaces(),
      loadLogs(),
      refreshSerialStatus(),
      refreshRegStatus(),
      loadTestCases(),
      loadSequence(),
    ]);
    startCapturePolling();
    // Serial polling every 1500ms when on HyperTerminal tab
    state.serialTimer = setInterval(() => {
      const activeView = document.querySelector('.view.active');
      if (activeView?.id === 'hyperTermView') refreshSerialStatus();
    }, 1500);
  } catch (err) {
    setStatus(`Offline — ${err.message}`, false);
    toast(`Server not reachable: ${err.message}`, 'bad');
  }
}

// ── Proto block helpers (delegate to data model) ──────────────────────────────
function addProtoBlock(proto) { addProtoBlockToPacket(proto); }
function removeProtoBlock(proto) { const pkt=getActivePackets()[state.selectedPacketIdx]; if(!pkt)return; const bi=pkt.blocks.findIndex(b=>b.type===proto); if(bi>=0)removeBlockAt(bi); }
function selectProtoBlock(proto) { const pkt=getActivePackets()[state.selectedPacketIdx]; if(!pkt)return; const bi=pkt.blocks.findIndex(b=>b.type===proto); if(bi>=0)selectBlock(bi); }

// ── Panel toggles + drag-and-drop ─────────────────────────────────────────────
function initLayoutExtras() {
  $('ifaceToggle')?.addEventListener('click', () => { document.querySelector('.cap-iface-panel')?.classList.toggle('collapsed'); });
  $('regViewerToggle')?.addEventListener('click', () => { $('regViewerPanel')?.classList.toggle('collapsed'); });

  document.querySelectorAll('.palette-proto[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => {
      _dragBlockIdx = -1;
      e.dataTransfer.setData('proto', el.dataset.proto);
    });
  });
  const blockList = $('blockList');
  if (blockList) {
    blockList.addEventListener('dragover', e => { e.preventDefault(); blockList.classList.add('drag-over'); });
    blockList.addEventListener('dragleave', e => { if (!blockList.contains(e.relatedTarget)) blockList.classList.remove('drag-over'); });
    blockList.addEventListener('drop', e => {
      e.preventDefault(); blockList.classList.remove('drag-over');
      if (_dragBlockIdx >= 0) { _dragBlockIdx = -1; return; } // handled by block chip
      const proto = e.dataTransfer.getData('proto'); if (proto) addProtoBlockToPacket(proto);
    });
  }
}

// ── initApp: wire new IDs not handled by preserved init() ─────────────────────
function initApp() {
  // Packet Generator
  $('pgAddPacket')?.addEventListener('click', addPacket);
  $('pgPeriod')?.addEventListener('input', updateEstimatedTime);
  $('pgDelPacket')?.addEventListener('click', deleteSelectedPackets);
  $('pgUpPacket')?.addEventListener('click', () => movePacket(-1));
  $('pgDownPacket')?.addEventListener('click', () => movePacket(1));
  $('pgDupPacket')?.addEventListener('click', duplicatePacket);
  $('pgSelectAll')?.addEventListener('change', e => {
    document.querySelectorAll('.pkt-chk').forEach(c => { c.checked = e.target.checked; const p = getActivePackets()[Number(c.dataset.idx)]; if (p) p.checked = e.target.checked; });
  });
  $('pgSendSelected')?.addEventListener('click', sendSelectedPackets);
  $('pgSendList')?.addEventListener('click', sendPacketList);
  // TC floating dropdown
  $('pgTcBtn')?.addEventListener('click', e => { e.stopPropagation(); toggleTcDropdown(); });
  $('pgTcClose')?.addEventListener('click', clearTcMode);
  // close dropdown on outside click
  document.addEventListener('click', e => {
    if (_tcDropOpen && !$('pgTcDropdown')?.contains(e.target) && e.target !== $('pgTcBtn')) {
      closeTcDropdown();
    }
  });

  // Palette clicks → add block
  document.querySelectorAll('.palette-proto[data-proto]').forEach(el => {
    el.addEventListener('click', () => addProtoBlockToPacket(el.dataset.proto));
  });

  // Scenario Lab — CSV tree + sequence
  $('tcReloadCsv')?.addEventListener('click', () => { _csvTreeHash = ''; loadCsvTree(); toast('Reloading CSV tree…', 'ok'); });
  initCsvUpload();
  initPaletteDnD();
  $('tcAddToSeq')?.addEventListener('click', tcAddToSeq);
  $('scRowAdd')?.addEventListener('click',  addPacket);
  $('scRowDel')?.addEventListener('click',  deletePacket);
  $('scRowDup')?.addEventListener('click',  duplicatePacket);
  $('scRowUp')?.addEventListener('click',   () => movePacket(-1));
  $('scRowDown')?.addEventListener('click', () => movePacket(1));
  $('scSaveCsv')?.addEventListener('click', saveCsvTc);
  $('seqRun')?.addEventListener('click', () => { if (state.seqRunning) stopRunning(); else runSeqSequence(); });
  $('seqReset')?.addEventListener('click', () => {
    stopRunning();
    state.tcSeqList.forEach(tc => { tc.status = 'pending'; });
    renderTcSeqList();
    const tbody = $('sequenceRows');
    if (tbody) tbody.innerHTML = '';
    const titleEl = $('scDetailTitle'); if (titleEl) titleEl.textContent = 'TEST SEQUENCE — (select a TC)';
    state.selectedSeqTcIdx = -1;
    appendSeqTerm('↺ Sequence reset');
  });
  $('scSendSelected')?.addEventListener('click', () => { if (state.sendRunning) stopRunning(); else scenarioSendSelected(); });
  $('scSendList')?.addEventListener('click', () => { if (state.sendRunning) stopRunning(); else scenarioSendList(); });

  // Capture extras
  $('captureFilterApply')?.addEventListener('click', renderCaptureRows);
  $('captureFilterClear')?.addEventListener('click', () => { const f = $('captureFilter'); if (f) f.value = ''; renderCaptureRows(); });
  $('copyPacketDetails')?.addEventListener('click', () => {
    navigator.clipboard?.writeText($('packetDetails')?.textContent || '').then(() => toast('Copied!', 'ok'));
  });
  $('copyPacketHex')?.addEventListener('click', () => {
    navigator.clipboard?.writeText($('packetHex')?.textContent || '').then(() => toast('Copied!', 'ok'));
  });

  // Load CSV tree and start poller
  loadCsvTree();
  startCsvPoller();
}

initLayoutExtras();
init();
initApp();
