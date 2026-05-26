'use strict';

export const state = {
  interfaces: [],
  captureInterfaces: new Set(),
  captureRows: [],
  captureIfaceFilter: new Set(),
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
  activeList: 'pg',
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
