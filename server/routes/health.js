'use strict';
const { Router } = require('express');
const os     = require('os');
const router = Router();

router.get('/health', async (req, res) => {
  const { packetBackend, serialBridge } = req.app.locals;
  let serialPorts = [];
  try { if (serialBridge?.isAvailable?.()) serialPorts = await serialBridge.list(); } catch {}

  res.json({
    ok:       true,
    mode:     'node-native',
    platform: process.platform,
    server:   { name: 'packet-lab-manager', port: Number(process.env.PORT || 8080), version: '2.0.0' },
    packets:  { cap: Boolean(packetBackend.isAvailable?.()), tcpdump: Boolean(packetBackend.isTcpdumpAvailable?.()) },
    serial:   { available: Boolean(serialBridge?.isAvailable?.()), open: Boolean(serialBridge?.getStatus?.().open), ports: serialPorts.map(p => p.path || p.name).filter(Boolean) },
    time:     new Date().toISOString(),
  });
});

router.get('/backend/status', async (req, res) => {
  const { packetBackend, serialBridge } = req.app.locals;
  let serialPorts = [];
  try { if (serialBridge?.isAvailable?.()) serialPorts = await serialBridge.list(); } catch {}

  const cap      = Boolean(packetBackend.isAvailable?.());
  const tcpdump  = Boolean(packetBackend.isTcpdumpAvailable?.());
  const serial   = Boolean(serialBridge?.isAvailable?.());
  const serOpen  = Boolean(serialBridge?.getStatus?.().open);
  const ifaces   = packetBackend.listInterfaces();

  res.json({
    ok:       true,
    mode:     'node-native',
    platform: { type: os.type(), platform: os.platform(), arch: os.arch(), node: process.version },
    nodeNative: {
      packetSend: cap, packetCapture: cap || tcpdump, cap, tcpdump,
      serial, serialOpen: serOpen,
      serialPorts: serialPorts.map(p => p.path || p.name).filter(Boolean),
      interfaces:  ifaces.map(i => ({ name: i.name, state: i.state, mac: i.mac, ipv4: i.ipv4 || [] })),
    },
    features: { send: cap, capture: cap || tcpdump, serial, register: serOpen, fdb: serOpen, mdio: serOpen, reports: true },
    time: new Date().toISOString(),
  });
});

module.exports = router;
