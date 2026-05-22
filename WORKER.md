# 멀티 노드 구성 (Multi-Node Setup)

각 PC에서 독립적으로 PacketLabManager 서버를 실행하고,  
Scenario Lab 탭에서 원격 노드 URL을 지정해 연동합니다.

---

## 기본 구성

```
PC-A (송신)   node server.js  →  http://192.168.1.10:8080
PC-B (수신)   node server.js  →  http://192.168.1.20:8080

브라우저에서 PC-A 접속 후 Scenario Lab → Node B = http://192.168.1.20:8080
```

### Windows 실행

```bat
:: 각 PC에서 관리자 권한으로
start.bat
```

### Linux 실행

```bash
sudo node server.js
# 또는 setcap 설정 후 일반 유저로
```

---

## 원격 노드 API

원격 노드 연결 확인:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://192.168.1.10:8080/api/remote-capture/probe `
  -ContentType application/json `
  -Body '{"peerUrl":"http://192.168.1.20:8080"}'
```

원격 노드에서 캡처 시작:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://192.168.1.20:8080/api/capture/start `
  -ContentType application/json `
  -Body '{"interfaces":["eth0"]}'
```

PC-A에서 패킷 전송:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://192.168.1.10:8080/api/send `
  -ContentType application/json `
  -Body '{
    "interface": "eth0",
    "protocol": "udp",
    "dstMac": "FF:FF:FF:FF:FF:FF",
    "srcIp": "192.168.1.10",
    "dstIp": "192.168.1.20",
    "srcPort": 40000,
    "dstPort": 50000,
    "count": 10,
    "intervalMs": 10,
    "payload": {"mode":"text","data":"KETI_TEST"}
  }'
```

PC-B에서 캡처 결과 확인:

```powershell
Invoke-RestMethod -Uri http://192.168.1.20:8080/api/capture/packets?limit=100
```

---

## 양방향 포워딩 테스트 (A↔B)

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://192.168.1.10:8080/api/simple-bidir-forward-test `
  -ContentType application/json `
  -Body '{
    "nodeAUrl": "http://192.168.1.10:8080",
    "nodeBUrl": "http://192.168.1.20:8080",
    "nodeAPrimaryInterface": "eth0",
    "nodeBPrimaryInterface": "eth0",
    "count": 10,
    "intervalMs": 100,
    "direction": "BOTH"
  }'
```

응답 예시:

```json
{
  "ok": true,
  "overall": "PASS",
  "directions": [
    { "direction": "A_TO_B", "result": "PASS", "sent": 10, "matched": 10 },
    { "direction": "B_TO_A", "result": "PASS", "sent": 10, "matched": 10 }
  ]
}
```
