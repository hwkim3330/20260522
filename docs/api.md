# API Reference

Base URL: `http://localhost:8080/api`  
Content-Type: `application/json`

---

## 시스템

### GET /version
버전 정보 반환.

```json
{ "ok": true, "version": "1.0.0", "commit": "1.0.0" }
```

### GET /csharp/health
WPF 워커 연결 상태 확인.

```json
{ "ok": true, "connected": true, "note": "EthernetPacketGenerator WebSocket worker" }
```

### GET /local-addresses
서버 호스트의 네트워크 인터페이스 IP 목록.

```json
{
  "ok": true,
  "addresses": [{ "name": "Ethernet", "address": "172.16.0.1", "netmask": "255.255.0.0" }],
  "primary": "172.16.0.1"
}
```

---

## 패킷 (Packet)

### GET /interfaces
WPF가 인식한 네트워크 인터페이스 목록.

```json
{
  "ok": true,
  "interfaces": [
    { "key": "\\Device\\NPF_{...}", "name": "Ethernet", "mac": "aa:bb:cc:dd:ee:ff", "state": "up", "ipv4": ["172.16.0.1"] }
  ]
}
```

### POST /build
패킷 프레임을 빌드하고 헥스 덤프를 반환합니다 (전송하지 않음).

**Request body:**
```json
{
  "interface": "\\Device\\NPF_{...}",
  "protocol": "udp",
  "dstMac": "FF:FF:FF:FF:FF:FF",
  "srcIp": "192.168.1.1",
  "dstIp": "192.168.1.2",
  "srcPort": 12345,
  "dstPort": 50000,
  "payload": { "mode": "text", "data": "KETI" }
}
```

`protocol`: `udp` | `tcp` | `icmp` | `arp` | `raw`

**Response:**
```json
{ "ok": true, "hex": "ffffffffffff...", "length": 60 }
```

### POST /send
패킷 전송.

Request body: `/build` 와 동일 + `count`, `intervalMs` 추가.

```json
{
  "interface": "...",
  "protocol": "udp",
  "dstMac": "FF:FF:FF:FF:FF:FF",
  "srcIp": "192.168.1.1",
  "dstIp": "192.168.1.2",
  "srcPort": 12345,
  "dstPort": 50000,
  "count": 10,
  "intervalMs": 100,
  "payload": { "mode": "text", "data": "KETI" }
}
```

**Response:**
```json
{ "ok": true, "sent": 10 }
```

### POST /packet/send
`/send` 별칭.

---

## 캡처 (Capture)

### POST /capture/start
캡처 시작.

```json
{ "interfaces": ["\\Device\\NPF_{...}"] }
```

### POST /capture/stop
캡처 중지.

```json
{}
```

### POST /capture/clear
캡처 버퍼 초기화.

```json
{}
```

### GET /capture/packets
캡처된 패킷 목록.

Query: `?limit=500&offset=0`

**Response:**
```json
{
  "ok": true,
  "rows": [
    {
      "id": 1,
      "ts": "2026-05-18T12:00:00.000Z",
      "iface": "Ethernet",
      "len": 60,
      "hex": "ffffffffffff...",
      "decoded": {
        "eth": { "src": "aa:bb:cc:dd:ee:ff", "dst": "ff:ff:ff:ff:ff:ff", "type": "0x0800" },
        "ip": { "src": "192.168.1.1", "dst": "192.168.1.2", "proto": "UDP" },
        "udp": { "srcPort": 12345, "dstPort": 50000 },
        "payload": "KETI"
      }
    }
  ],
  "total": 1
}
```

---

## 시리얼 (TTY)

### GET /tty/list
사용 가능한 COM 포트 목록.

```json
{
  "ok": true,
  "ports": ["COM3", "COM4"],
  "ttys": []
}
```

### POST /tty/open
시리얼 포트 열기.

```json
{
  "port": "COM3",
  "baudRate": 115200,
  "dataBits": 8,
  "stopBits": 1,
  "parity": "None"
}
```

### POST /tty/send
데이터 전송.

```json
{ "sessionId": "...", "data": "hello\r\n", "hex": false }
```

### POST /tty/close
세션 닫기.

```json
{ "sessionId": "..." }
```

---

## 레지스터 (Register)

### GET /register/status
레지스터 서비스 상태 및 현재 디바이스 정보.

### POST /register/read
레지스터 읽기.

```json
{ "devAddr": 0, "regAddr": 0 }
```

**Response:**
```json
{ "ok": true, "value": "0x1234", "raw": 4660 }
```

### POST /register/write
레지스터 쓰기.

```json
{ "devAddr": 0, "regAddr": 0, "value": "0x1234" }
```

---

## FDB

### GET /fdb/table
FDB 테이블 전체 조회.

```json
{
  "ok": true,
  "entries": [
    { "mac": "aa:bb:cc:dd:ee:ff", "port": 1, "vlan": 1, "type": "dynamic" }
  ]
}
```

### POST /fdb/flush
FDB 테이블 초기화.

---

## 시나리오 (Scenario)

### GET /scenario/list
등록된 시나리오 목록.

### POST /scenario/run
시나리오 실행.

```json
{ "scenarioId": "...", "params": {} }
```

---

## 테스트 (Tests)

### GET /testcases
테스트 케이스 목록.

### POST /tests/run
테스트 케이스 실행.

```json
{ "id": "test-uuid" }
```

**Response:**
```json
{
  "ok": true,
  "result": "PASS",
  "steps": [
    { "step": "send", "ok": true },
    { "step": "capture", "matched": 10, "expected": 10, "result": "PASS" }
  ]
}
```

---

## 멀티 노드 (Workers)

### GET /workers
연결된 워커 노드 목록.

```json
{
  "ok": true,
  "workers": [
    { "id": "local", "connected": true, "connectedAt": "2026-05-18T12:00:00Z" }
  ]
}
```

### POST /probe-node
원격 노드의 인터페이스 조회.

```json
{ "url": "http://192.168.1.100:8080" }
```

---

## 양방향 포워딩 테스트

### POST /simple-bidir-forward-test
두 노드 간 패킷 포워딩 PASS/FAIL 테스트.

**Request body:**
```json
{
  "nodeAUrl": "http://192.168.1.1:8080",
  "nodeBUrl": "http://192.168.1.2:8080",
  "nodeAPrimaryInterface": "eth0",
  "nodeBPrimaryInterface": "eth0",
  "count": 10,
  "intervalMs": 100,
  "direction": "BOTH"
}
```

**Response:**
```json
{
  "ok": true,
  "report": {
    "overall": "PASS",
    "directions": [
      { "direction": "A_TO_B", "result": "PASS", "sent": 10, "matched": 10 },
      { "direction": "B_TO_A", "result": "PASS", "sent": 10, "matched": 10 }
    ]
  }
}
```

---

## MDIO / PHY

### POST /mdio/read
PHY 레지스터 읽기. MDIO 버스를 통해 지정 포트/PHY 주소/레지스터 주소를 읽습니다.

**Request body:**
```json
{ "port": 0, "phyAddr": "0x00", "regAddr": "0x01" }
```

**Response:**
```json
{ "ok": true, "value": "0x796D", "raw": 31085 }
```

### POST /mdio/write
PHY 레지스터 쓰기.

**Request body:**
```json
{ "port": 0, "phyAddr": "0x00", "regAddr": "0x00", "value": "0x1200" }
```

### GET /mdio/link-status
모든 6개 포트의 링크 상태 읽기 (BMSR reg 0x01 bit2).

**Response:**
```json
{ "ok": true, "ports": [{ "port": 0, "linkUp": true }, { "port": 1, "linkUp": false }] }
```

### POST /mdio/setup
포트별 MDIO 컨트롤러 설정 (클럭 속도, 활성화, 인터럽트).

**Request body:**
```json
{ "port": 0, "enable": true, "preDisable": false, "interruptEnable": false, "targetMhz": 2.5 }
```

**Response:**
```json
{ "ok": true, "setup": "0x01610000", "time": "0x00064009", "clk": 20, "ms": 2500 }
```

---

## Counter (포트 카운터)

### GET /counter/read?port=all|0-5
시리얼 포트를 통해 스위치 포트 카운터를 읽습니다.

Query: `?port=all` (기본) 또는 `?port=0` ~ `?port=5`

**Response:**
```json
{
  "ok": true,
  "counters": [
    { "group": "RX0", "name": "RX0_PKT", "address": "0x1000", "value": "0x0000001A", "valueDec": 26 }
  ]
}
```

---

## Timestamp (PTP 클럭)

### GET /timestamp/read
하드웨어 PTP 타임스탬프를 읽습니다. NS 읽기가 SEC 스냅샷을 트리거합니다.

**Response:**
```json
{ "ok": true, "ns": 123456789, "secLo": 1747555200, "secHi": 0, "sec": 1747555200, "isoString": "2025-05-18T12:00:00.000Z" }
```

### POST /timestamp/set
하드웨어 PTP 타임스탬프를 설정합니다.

**Request body:**
```json
{ "year": 2025, "month": 5, "day": 18, "hour": 12, "min": 0, "sec": 0, "ns": 0 }
```

**Response:**
```json
{ "ok": true, "unixSec": 1747555200, "isoString": "2025-05-18T12:00:00.000Z" }
```

### GET /timestamp/status
ADDEND, INCREMENT, PPS 설정을 읽습니다.

**Response:**
```json
{ "ok": true, "ctrl0": "0x00000000", "ctrl1": "0x00000000", "addend": 0, "increment": 0, "ppsSrc": 1, "ppsWidthMs": 100 }
```

---

## WebSocket 이벤트

브라우저는 `ws://localhost:8080` 에 연결하여 워커 이벤트를 수신합니다.

```json
// 탭 전환 이벤트 (WPF → Node.js → Browser)
{
  "type": "workerEvent",
  "payload": {
    "kind": "tabchange",
    "view": "serialView"
  }
}
```

`view` 값: `senderView` | `labView` | `captureView` | `serialView` | `controlView` | `registerView` | `fdbView` | `autoView`
