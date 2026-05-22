# PacketLabManager

**이더넷 패킷 생성 · 캡처 · 시나리오 검증 통합 플랫폼**

> Integrated Ethernet Packet Generation, Capture & Scenario Validation Platform

**Windows + Linux 동시 지원** — Node.js 단독으로 모든 기능 동작 (C# 불필요)

---

## 개요 (Overview)

PacketLabManager는 이더넷 네트워크 테스트를 위한 순수 Node.js 기반 풀스택 랩 도구입니다.

- **Windows**: Npcap 기반 패킷 송수신 + 시리얼 + 레지스터/FDB/MDIO
- **Linux**: libpcap(cap npm) 또는 tcpdump 기반 패킷 캡처 + 동일한 모든 기능

| 구성요소 | 역할 | 플랫폼 |
|---------|------|--------|
| **PacketLabManager Server** (Node.js) | REST API + WebSocket + 웹 UI 서빙 | **Windows + Linux** |
| **Web UI** (Vanilla JS) | 브라우저 기반 통합 인터페이스 | **Windows + Linux** |

### 주요 기능

- UDP / TCP / ICMP / ARP / 커스텀 이더넷 패킷 빌드 및 전송
- Npcap / libpcap / tcpdump 기반 실시간 패킷 캡처 + 헥스·프로토콜 디코드
- 멀티 노드 원격 캡처 (A↔B 포워딩 테스트, PASS/FAIL 리포트)
- HyperTerminal: 시리얼 콘솔, PHY 레지스터 R/W, FDB 테이블, MDIO, 카운터
- 테스트 케이스 관리 (CSV/JSON 임포트) 및 자동화 시퀀서
- Linux headless 지원 — 임베디드 보드 / CI 환경

---

## 아키텍처 (Architecture)

```
┌──────────────────────────────────────────────────────────┐
│  Browser  http://localhost:8080                          │
│  Vanilla JS Web UI  ◄── WebSocket (serial rx 실시간) ──► │
└──────────────────────────┬───────────────────────────────┘
                           │  REST API
┌──────────────────────────▼───────────────────────────────┐
│  PacketLabManager Server  (Node.js  :8080)               │
│  Express REST API  +  WebSocket 브로드캐스트              │
│                                                          │
│  nativeWorker.dispatch()                                 │
│    ├─ packetBackend   (cap npm / tcpdump)                │
│    ├─ serialBridge    (serialport npm / stty)            │
│    ├─ switchProtocol  (레지스터 / FDB 텍스트 프로토콜)     │
│    └─ autoEngine      (JS 자동화 테스트 러너)             │
└──────────────────────────────────────────────────────────┘
```

---

## 사전 요구사항 (Prerequisites)

### Windows

| 항목 | 버전 | 비고 |
|------|------|------|
| Windows | 10 / 11 64-bit | |
| [Npcap](https://npcap.com) | 1.79 이상 | 패킷 캡처·전송 드라이버 |
| [Node.js](https://nodejs.org) | 18 LTS 이상 | |

> **Npcap 설치 시** "WinPcap API-compatible Mode" 옵션을 체크하세요.  
> 패킷 기능 사용 시 **관리자 권한**으로 실행 필요.

### Linux (Ubuntu / Debian)

| 기능 수준 | 필요 패키지 |
|-----------|------------|
| 시리얼·레지스터·자동화 | `nodejs npm` |
| 패킷 캡처 (tcpdump) | `nodejs npm tcpdump` |
| 패킷 전송+캡처 (libpcap) | `nodejs npm libpcap-dev build-essential` |

---

## 설치 및 실행 (Installation & Run)

### Windows — `start.bat` 실행 (권장)

```
start.bat  ← 우클릭 → 관리자 권한으로 실행
```

또는 수동:

```bat
cd server
npm install
node server.js
```

브라우저: `http://localhost:8080`

---

### Linux — 빠른 시작

```bash
# 1. 시스템 패키지 (Ubuntu/Debian)
sudo apt install -y git nodejs npm tcpdump

# 선택: 패킷 전송도 필요하면
# sudo apt install -y libpcap-dev build-essential

# 2. 클론
git clone https://github.com/hwkim3330/20260522.git
cd 20260522/server

# 3. 의존성 설치
npm install

# 4. 실행
sudo node server.js
# root 없이 실행하려면:
# sudo setcap cap_net_raw+eip $(which node) && node server.js
```

브라우저: `http://localhost:8080`

---

## 기능 매트릭스

| 기능 | Windows (Npcap) | Linux (cap) | Linux (tcpdump) |
|------|:---------------:|:-----------:|:---------------:|
| 패킷 전송 (UDP/ICMP/ARP/...) | ✅ | ✅ | ❌ |
| 패킷 캡처 | ✅ | ✅ | ✅ |
| 시리얼 콘솔 | ✅ | ✅ | ✅ |
| 레지스터 R/W | ✅ | ✅ | ✅ |
| FDB R/W/flush | ✅ | ✅ | ✅ |
| MDIO R/W | ✅ | ✅ | ✅ |
| 카운터 읽기 | ✅ | ✅ | ✅ |
| 타임스탬프 R/W | ✅ | ✅ | ✅ |
| 자동화 테스트 | ✅ | ✅ | ✅ |
| 원격 노드 캡처 | ✅ | ✅ | ✅ |

---

## 웹 UI 탭 안내

| 탭 | 설명 |
|----|------|
| **Packet Generator** | UDP·TCP·ICMP·ARP·Raw 이더넷 패킷 빌드 및 전송 |
| **Scenario Lab** | 멀티 노드 A↔B 포워딩 시나리오 테스트 (PASS/FAIL) |
| **Capture** | 실시간 패킷 캡처 — 헥스 덤프 · 프로토콜 디코드 |
| **HyperTerminal** | 시리얼 콘솔·레지스터·FDB·MDIO·카운터·자동화 |

---

## API 요약

Base URL: `http://localhost:8080/api`

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/health` | 서버 상태 (cap 여부, 시리얼 여부) |
| GET | `/version` | 버전 정보 |
| GET | `/local-addresses` | 로컬 IP 목록 |
| POST | `/build` | 패킷 빌드 (전송 없이 프레임 생성) |
| POST | `/send` | 패킷 전송 |
| POST | `/capture/start` | 캡처 시작 |
| POST | `/capture/stop` | 캡처 중지 |
| GET | `/capture/packets` | 캡처된 패킷 목록 |
| POST | `/capture/clear` | 캡처 버퍼 초기화 |
| GET | `/capture/status` | 캡처 상태 및 인터페이스 목록 |
| GET | `/tty/list` | 시리얼 포트 목록 |
| POST | `/tty/open` | 시리얼 세션 열기 |
| POST | `/tty/write` | 시리얼 데이터 전송 |
| POST | `/tty/close` | 시리얼 세션 닫기 |
| GET | `/tty/stream` | 시리얼 수신 NDJSON 스트림 |
| POST | `/register/read` | 레지스터 읽기 |
| POST | `/register/write` | 레지스터 쓰기 |
| GET | `/register/status` | 레지스터 서비스 상태 |
| POST | `/fdb/read` | FDB 테이블 읽기 |
| POST | `/fdb/write` | FDB 항목 추가 |
| POST | `/fdb/flush` | FDB 초기화 |
| POST | `/mdio/read` | PHY 레지스터 읽기 |
| POST | `/mdio/write` | PHY 레지스터 쓰기 |
| GET | `/mdio/link-status` | 포트 링크 상태 |
| GET | `/counter/read` | 포트 카운터 읽기 |
| GET | `/testcases/status` | 테스트 케이스 목록 |
| POST | `/testcases/import-all-csv` | CSV 시나리오 전체 임포트 |
| GET | `/sequence/status` | 시퀀스 목록 |
| POST | `/sequence/run` | 현재 시퀀스 실행 |
| GET | `/auto/status` | 자동화 테스트 상태 |
| POST | `/auto/run` | 자동화 테스트 실행 |
| POST | `/remote-capture/probe` | 원격 노드 연결 확인 |

---

## 프로젝트 구조

```
20260522/
├── server/
│   ├── server.js              # 진입점 — Npcap PATH, WebSocket, 라우트 등록
│   ├── package.json
│   ├── routes/
│   │   ├── health.js          # 서버 상태
│   │   ├── packet.js          # 패킷 빌드·전송
│   │   ├── capture.js         # 패킷 캡처
│   │   ├── tty.js             # 시리얼 포트
│   │   ├── register.js        # 레지스터 R/W
│   │   ├── fdb.js             # FDB 관리
│   │   ├── mdio.js            # MDIO/PHY
│   │   ├── counter.js         # 포트 카운터
│   │   ├── timestamp.js       # PTP 타임스탬프
│   │   ├── scenario.js        # 시나리오·시퀀스·테스트케이스
│   │   ├── auto.js            # 자동화 테스트 러너
│   │   ├── remoteCapture.js   # 원격 노드 프록시
│   │   └── ...
│   ├── services/
│   │   ├── nativeWorker.js    # 명령 디스패처
│   │   ├── packetBackend.js   # cap npm + tcpdump fallback
│   │   ├── serialBridge.js    # 시리얼 관리
│   │   ├── switchProtocol.js  # 레지스터·FDB 프로토콜
│   │   ├── frameBuilder.js    # 이더넷 프레임 빌더
│   │   └── autoEngine.js      # 자동화 테스트 엔진
│   ├── public/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
│   ├── testScenarios/         # CSV 테스트 시나리오 파일
│   └── logs/                  # 실행 로그·테스트 결과
├── docs/
├── start.bat                  # Windows 실행 스크립트 (관리자 권한)
├── .gitignore
└── README.md
```

---

## 멀티 노드 구성

여러 PC에서 각각 서버를 실행하고 Scenario Lab에서 원격 노드 URL을 지정하면 됩니다.

```
PC-A: node server.js  →  http://192.168.1.10:8080
PC-B: node server.js  →  http://192.168.1.20:8080

브라우저(PC-A): Scenario Lab → Node B URL = http://192.168.1.20:8080
```

자세한 내용: [`WORKER.md`](WORKER.md)

---

## 라이선스 (License)

MIT License — © 2026 KETI (Korea Electronics Technology Institute)
