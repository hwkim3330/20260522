'use strict';
/**
 * frameBuilder.js — Pure JS Ethernet frame construction.
 * Mirrors C# LabPacketService.BuildFrame() for Linux / headless operation.
 */

function macBytes(mac) {
  return Buffer.from((mac || 'ff:ff:ff:ff:ff:ff').replace(/[:\-]/g, '').padStart(12, '0'), 'hex');
}

function ipBytes(ip) {
  return Buffer.from((ip || '0.0.0.0').split('.').map(Number));
}

function u16be(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v >>> 0);
  return b;
}

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2)
    sum += (i + 1 < buf.length) ? (buf[i] << 8) + buf[i + 1] : buf[i] << 8;
  while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
  return (~sum) & 0xFFFF;
}

function parseHex(s) { return parseInt(String(s ?? '0').replace(/^0x/i, ''), 16) || 0; }

function payloadBytes(p, seq) {
  const pl = p.payload || {};
  const mode = (pl.mode || 'text').toLowerCase();
  if (mode === 'hex') return Buffer.from((pl.data || '').replace(/[:\s]/g, ''), 'hex');
  if (mode === 'random') {
    const len = pl.length || pl.size || 64;
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = Math.random() * 256 | 0;
    return b;
  }
  let text = pl.data || pl.text || '';
  if (seq != null) text += `_${seq}`;
  return Buffer.from(text, 'utf8');
}

function buildUDP(p, seq) {
  const u = p.udp || {};
  const data  = payloadBytes(p, seq);
  const sp    = u.srcPort ?? p.srcPort ?? 40000;
  const dp    = u.dstPort ?? p.dstPort ?? 50000;
  const len   = 8 + data.length;
  const ip    = p.ipv4 || {};
  const srcIp = Buffer.from((ip.src || '0.0.0.0').split('.').map(Number));
  const dstIp = Buffer.from((ip.dst || '0.0.0.0').split('.').map(Number));

  // UDP header (checksum = 0 for simplicity)
  const hdr = Buffer.concat([u16be(sp), u16be(dp), u16be(len), u16be(0)]);
  // Pseudo-header for checksum
  const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 17]), u16be(len)]);
  const full   = Buffer.concat([pseudo, hdr, data]);
  const cs     = checksum(full);
  hdr.writeUInt16BE(cs, 6);
  return Buffer.concat([hdr, data]);
}

function buildICMP(p, seq) {
  const data = payloadBytes(p, seq);
  const hdr  = Buffer.alloc(8);
  hdr[0] = 8; hdr[1] = 0; // Echo request
  hdr.writeUInt16BE(1, 4); // identifier
  hdr.writeUInt16BE(seq ?? 0, 6); // sequence
  const payload = Buffer.concat([hdr, data]);
  const cs = checksum(payload);
  payload.writeUInt16BE(cs, 2);
  return payload;
}

function buildARP(p) {
  const ip = p.ipv4 || {};
  const b  = Buffer.alloc(28);
  b.writeUInt16BE(0x0001, 0); // Ethernet
  b.writeUInt16BE(0x0800, 2); // IPv4
  b[4] = 6; b[5] = 4;
  b.writeUInt16BE(1, 6); // request
  macBytes(p.srcMac).copy(b, 8);
  ipBytes(ip.src).copy(b, 14);
  macBytes(p.dstMac).copy(b, 18);
  ipBytes(ip.dst).copy(b, 24);
  return b;
}

function buildTCP(p, seq) {
  const t      = p.tcp || {};
  const data   = payloadBytes(p, seq);
  const sp     = t.srcPort  ?? p.srcPort  ?? 40000;
  const dp     = t.dstPort  ?? p.dstPort  ?? 50000;
  const seqNum = t.seq      ?? (seq != null ? seq : 0);
  const ackNum = t.ack      ?? 0;
  // Default: PSH+ACK (0x18) when payload present, SYN (0x02) otherwise
  const flags  = t.flags    ?? (data.length > 0 ? 0x18 : 0x02);
  const win    = t.window   ?? 65535;

  const hdr = Buffer.alloc(20);
  hdr.writeUInt16BE(sp,      0);
  hdr.writeUInt16BE(dp,      2);
  hdr.writeUInt32BE(seqNum,  4);
  hdr.writeUInt32BE(ackNum,  8);
  hdr[12] = 0x50;               // data offset = 5 (20 bytes header)
  hdr[13] = flags;
  hdr.writeUInt16BE(win,    14);

  const ip     = p.ipv4 || {};
  const srcIp  = Buffer.from((ip.src || '0.0.0.0').split('.').map(Number));
  const dstIp  = Buffer.from((ip.dst || '0.0.0.0').split('.').map(Number));
  const tcpLen = 20 + data.length;
  const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 6]), u16be(tcpLen)]);
  const cs     = checksum(Buffer.concat([pseudo, hdr, data]));
  hdr.writeUInt16BE(cs, 16);

  return Buffer.concat([hdr, data]);
}

function buildIPv4(p, proto, innerPayload) {
  const ip  = p.ipv4 || {};
  const ttl = ip.ttl ?? 64;
  const tos = ip.tos ?? 0;
  const id  = ip.id  ?? (Math.random() * 0xFFFF | 0);
  const ff  = ip.flagsFragment ?? 0x4000;
  const tot = 20 + innerPayload.length;

  const h = Buffer.alloc(20);
  h[0] = 0x45; h[1] = tos;
  h.writeUInt16BE(tot, 2);
  h.writeUInt16BE(id, 4);
  h.writeUInt16BE(ff, 6);
  h[8] = ttl; h[9] = proto;
  ipBytes(ip.src).copy(h, 12);
  ipBytes(ip.dst).copy(h, 16);
  const cs = checksum(h);
  h.writeUInt16BE(cs, 10);
  return Buffer.concat([h, innerPayload]);
}

function buildEthHdr(p, etherType) {
  const vlan = p.vlan;
  const dst  = macBytes(p.dstMac);
  const src  = macBytes(p.srcMac);
  if (vlan && vlan.enabled) {
    const pri = vlan.priority ?? 0;
    const dei = vlan.dei ? 1 : 0;
    const vid = vlan.id ?? 1;
    const tci = (pri << 13) | (dei << 12) | (vid & 0xFFF);
    return Buffer.concat([dst, src, u16be(0x8100), u16be(tci), u16be(etherType)]);
  }
  return Buffer.concat([dst, src, u16be(etherType)]);
}

function normalizeProfile(raw) {
  const p = JSON.parse(JSON.stringify(raw));
  if (!p.ipv4) p.ipv4 = {};
  if (p.srcIp && !p.ipv4.src) { p.ipv4.src = p.srcIp; delete p.srcIp; }
  if (p.dstIp && !p.ipv4.dst) { p.ipv4.dst = p.dstIp; delete p.dstIp; }

  const proto = (p.protocol || 'udp').toLowerCase();
  if (proto === 'udp') {
    if (!p.udp) p.udp = {};
    if (p.srcPort && !p.udp.srcPort) { p.udp.srcPort = p.srcPort; delete p.srcPort; }
    if (p.dstPort && !p.udp.dstPort) { p.udp.dstPort = p.dstPort; delete p.dstPort; }
  } else if (proto === 'tcp') {
    if (!p.tcp) p.tcp = {};
    if (p.srcPort && !p.tcp.srcPort) { p.tcp.srcPort = p.srcPort; delete p.srcPort; }
    if (p.dstPort && !p.tcp.dstPort) { p.tcp.dstPort = p.dstPort; delete p.dstPort; }
  }
  return p;
}

/** Build a raw Ethernet frame from a packet profile object. Returns Buffer. */
function buildFrame(profile, seq) {
  const p     = normalizeProfile(profile);
  const proto = (p.protocol || 'udp').toLowerCase();

  let frame;
  switch (proto) {
    case 'udp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 17, buildUDP(p, seq))]);
      break;
    case 'icmp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 1, buildICMP(p, seq))]);
      break;
    case 'tcp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 6, buildTCP(p, seq))]);
      break;
    case 'arp':
      frame = Buffer.concat([buildEthHdr(p, 0x0806), buildARP(p)]);
      break;
    case 'raw': {
      const et = parseHex(p.etherType ?? '0x88b5');
      frame = Buffer.concat([buildEthHdr(p, et), payloadBytes(p, seq)]);
      break;
    }
    default:
      throw new Error(`Unsupported protocol: ${proto}`);
  }

  if (frame.length < 60) frame = Buffer.concat([frame, Buffer.alloc(60 - frame.length)]);
  const target = p.targetFrameLength;
  if (target && target > frame.length)
    frame = Buffer.concat([frame, Buffer.alloc(target - frame.length)]);

  return frame;
}

module.exports = { buildFrame, normalizeProfile };
