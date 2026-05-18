'use strict';
/**
 * switchProtocol.js — Register/FDB text protocol over serial.
 * Protocol: "read 0x{ADDR}" → "OK 0x{VALUE}" / "write 0x{ADDR} 0x{VALUE}" → "OK"
 * Used as fallback when C# worker is not available (Linux / headless).
 */

const serialBridge = require('./serialBridge');

// Default base address for register operations
let BASE_ADDRESS = 0x44A00000;

function hex8(n)  { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }
function parseHex(s) { return parseInt(String(s ?? '0').replace(/^0x/i, ''), 16) || 0; }

// ── Register primitives ────────────────────────────────────────────────────────

async function readRegister(session, offset) {
  const addr = (BASE_ADDRESS + parseHex(offset)) >>> 0;
  const resp = await serialBridge.command(session, `read ${hex8(addr)}`, 3000);
  // resp is the text after "OK " e.g. "0xDEADBEEF"
  return parseHex(resp);
}

async function writeRegister(session, offset, value) {
  const addr = (BASE_ADDRESS + parseHex(offset)) >>> 0;
  const val  = (value >>> 0);
  await serialBridge.command(session, `write ${hex8(addr)} ${hex8(val)}`, 3000);
}

// ── Public: register API (offset relative to BASE_ADDRESS) ────────────────────

async function registerStatus() {
  const s = serialBridge.getStatus();
  return { baseAddress: hex8(BASE_ADDRESS), connected: s.open, session: s.session };
}

async function registerRead(payload) {
  const sid    = serialBridge.getSession(payload.session);
  const offset = parseHex(payload.offset ?? payload.address ?? '0');
  const value  = await readRegister(sid, offset);
  return { value: hex8(value), raw: value, offset: hex8(offset) };
}

async function registerWrite(payload) {
  const sid    = serialBridge.getSession(payload.session);
  const offset = parseHex(payload.offset ?? payload.address ?? '0');
  const value  = parseHex(payload.value ?? '0');
  await writeRegister(sid, offset, value);
  return { ok: true, offset: hex8(offset), value: hex8(value) };
}

// ── FDB register offsets ───────────────────────────────────────────────────────
const FDB = {
  OFF_MCU_MAC0:   0xA18,
  OFF_MCU_MAC1:   0xA1C,
  OFF_MCU_VLAN:   0xA20,
  OFF_MCU_PORT:   0xA24,
  OFF_MCU_BUCKET: 0xA28,
  OFF_MCU_CMD:    0xA2C,
  OFF_FDB_STATUS: 0xA40,
  OFF_CMD_STATUS: 0xA44,
  OFF_RD_BUCKET:  0xA48,
  OFF_RD_PORT:    0xA4C,
  OFF_RD_FLAGS:   0xA50,
  OFF_RD_MAC0:    0xA54,
  OFF_RD_MAC1:    0xA58,
  OFF_RD_MAC2:    0xA5C,
};

const CMD = {
  HASH_READ:    0x12,
  READ_BUCKET:  0x13,
  HASH_WRITE:   0x14,
  WRITE_BUCKET: 0x15,
  HASH_DELETE:  0x16,
  FLUSH_ALL:    0x70,
};

function parseMac(mac) {
  const b = mac.replace(/[:\-]/g, '');
  return Buffer.from(b.padStart(12, '0'), 'hex');
}

function macToWords(mac) {
  const b = parseMac(mac);
  const lo = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  const hi = (b[4] | (b[5] << 8)) >>> 0;
  return { lo, hi };
}

function wordsToMac(lo, hi) {
  const b = [lo & 0xFF, (lo >> 8) & 0xFF, (lo >> 16) & 0xFF, (lo >> 24) & 0xFF,
             hi & 0xFF, (hi >> 8) & 0xFF];
  return b.map(x => x.toString(16).padStart(2, '0')).join(':');
}

async function pollStatus(sid, mask, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
    const v = await readRegister(sid, FDB.OFF_CMD_STATUS);
    if (v & mask) return v;
  }
  throw new Error('FDB status timeout');
}

async function setMacAddress(sid, mac) {
  const { lo, hi } = macToWords(mac);
  await writeRegister(sid, FDB.OFF_MCU_MAC0, lo);
  await writeRegister(sid, FDB.OFF_MCU_MAC1, hi);
}

// ── Public: FDB API ───────────────────────────────────────────────────────────

async function fdbRead(payload) {
  const sid     = serialBridge.getSession(payload.session);
  const mac     = payload.mac || '00:00:00:00:00:00';
  const vlanId  = payload.vlanId ?? 0;
  const valid   = vlanId > 0;

  await setMacAddress(sid, mac);
  await writeRegister(sid, FDB.OFF_MCU_VLAN,
    (valid ? 0x1000 : 0) | (vlanId & 0xFFF));
  await writeRegister(sid, FDB.OFF_MCU_CMD, CMD.HASH_READ);

  const st = await pollStatus(sid, 0x1, 500); // STATUS_RD_MAC
  const bucket = await readRegister(sid, FDB.OFF_RD_BUCKET);
  const port   = await readRegister(sid, FDB.OFF_RD_PORT);
  const flags  = await readRegister(sid, FDB.OFF_RD_FLAGS);
  const mac0   = await readRegister(sid, FDB.OFF_RD_MAC0);
  const mac1   = await readRegister(sid, FDB.OFF_RD_MAC1);
  const mac2   = await readRegister(sid, FDB.OFF_RD_MAC2);
  const rdMac  = wordsToMac((mac0 | (mac1 << 16)) >>> 0, mac2 & 0xFFFF);

  return {
    found:  !!(flags & 0x8000),
    mac:    rdMac,
    port:   port & 0x1FF,
    vlanId: vlanId,
    static: !!(flags & 0x4000),
    bucket: bucket & 0x3FF,
  };
}

async function fdbWrite(payload) {
  const sid    = serialBridge.getSession(payload.session);
  const mac    = payload.mac || '00:00:00:00:00:00';
  const port   = payload.port ?? 0;
  const vlanId = payload.vlanId ?? 0;
  const valid  = vlanId > 0;
  const isStatic = payload.static ?? true;

  await setMacAddress(sid, mac);
  await writeRegister(sid, FDB.OFF_MCU_VLAN,
    (valid ? 0x1000 : 0) | (vlanId & 0xFFF));
  await writeRegister(sid, FDB.OFF_MCU_PORT, port & 0x1FF);
  if (isStatic) await writeRegister(sid, FDB.OFF_MCU_BUCKET, 0x000F0000); // slot bitmap
  await writeRegister(sid, FDB.OFF_MCU_CMD,
    isStatic ? CMD.WRITE_BUCKET : CMD.HASH_WRITE);

  await pollStatus(sid, 0x4, 500); // STATUS_WR_MAC
  return { ok: true };
}

async function fdbDelete(payload) {
  const sid    = serialBridge.getSession(payload.session);
  const mac    = payload.mac || '00:00:00:00:00:00';
  const vlanId = payload.vlanId ?? 0;
  const valid  = vlanId > 0;

  await setMacAddress(sid, mac);
  await writeRegister(sid, FDB.OFF_MCU_VLAN,
    (valid ? 0x1000 : 0) | (vlanId & 0xFFF));
  await writeRegister(sid, FDB.OFF_MCU_CMD, CMD.HASH_DELETE);
  await pollStatus(sid, 0x4, 500);
  return { ok: true };
}

async function fdbFlush(payload) {
  const sid = serialBridge.getSession(payload?.session);
  await writeRegister(sid, FDB.OFF_MCU_CMD, CMD.FLUSH_ALL);

  // Poll OFF_FDB_STATUS bit 0 (done_mac_table_init)
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
    const v = await readRegister(sid, FDB.OFF_FDB_STATUS);
    if (v & 0x1) return { ok: true };
  }
  throw new Error('FDB flush timeout');
}

module.exports = {
  registerStatus, registerRead, registerWrite,
  fdbRead, fdbWrite, fdbDelete, fdbFlush,
  readRegister, writeRegister,
  setBaseAddress(addr) { BASE_ADDRESS = parseHex(addr); },
};
