# VS PRIVATE NETWORK — Physical test instructions (operator)

Software implementation is on PR #52. These steps are for **real machines**.  
Automated tests do **NOT** set `PHYSICAL_i3=PASS`.

Addressing:
- SERVER `VS-CORE-01` → `10.77.0.1`
- ADMIN `VS-ADMIN-01` → `10.77.0.2`
- CLIENT pool → `10.77.10.x`
- WireGuard UDP listen (SERVER): `51820` (public WAN IP only for WG transport)

---

## A) i3 VS SERVER

```bash
# 1) Install OS packages
sudo apt update
sudo apt install -y wireguard wireguard-tools curl

# 2) Clone / sync VS repo to the i3, then:
cd /path/to/VS/SERVER
sudo ./INSTALL_SERVER

# 3) Set secrets on DATA (never in git)
sudo nano /var/lib/vs-server/server.env
# Must set:
#   API_ADMIN_TOKEN=<strong random>
#   VS_PRIVATE_NETWORK=1
#   CONTROL_API_HOST=10.77.0.1
#   LIVE_TRADING_ENABLED=false

# 4) Start SERVER (creates SERVER identity + keys under /var/lib/vs-server/network/keys)
sudo bash -c 'set -a; source /var/lib/vs-server/server.env; set +a; ./START_SERVER'

# 5) Firewall (default deny inbound; WG UDP + private subnet to API)
sudo ./network/APPLY_FIREWALL

# 6) Bring up WireGuard (if not already by START_SERVER)
sudo VS_SERVER_DATA=/var/lib/vs-server ./network/UP_WIREGUARD

# 7) Register ADMIN peer (writes private config under DATA/network/issued — copy securely)
sudo VS_SERVER_DATA=/var/lib/vs-server ./network/REGISTER_ADMIN VS-ADMIN-01
# Note: device_token + peer_config_path from JSON output — transfer out-of-band to ADMIN PC

# 8) (Optional) Register test CLIENT
sudo VS_SERVER_DATA=/var/lib/vs-server ./network/REGISTER_CLIENT_DEVICE 1 VS-CLIENT-0001

# 9) Diagnostics
sudo VS_SERVER_DATA=/var/lib/vs-server ./network/NETWORK_DIAGNOSTICS
sudo wg show
ip addr show vs0
```

Public endpoint for peers: your i3 **public IP or DNS:51820** (UDP only).  
Replace `SERVER_PUBLIC_HOST` inside issued `*.conf` with that host before importing on ADMIN/CLIENT.

---

## B) VS ADMIN COMPUTER

```bash
# 1) Install WireGuard on personal PC
# Linux:
sudo apt install -y wireguard wireguard-tools
# Windows/macOS: install official WireGuard app

# 2) Securely copy from SERVER:
#   - issued VS-ADMIN-01.conf (contains private key — protect it)
#   - device_token from REGISTER_ADMIN output

# 3) Edit Endpoint= in the conf to SERVER public host:51820
#    Address should be 10.77.0.2/32

# 4) Import/up tunnel
# Linux:
sudo cp VS-ADMIN-01.conf /etc/wireguard/vs-admin.conf
sudo chmod 600 /etc/wireguard/vs-admin.conf
sudo wg-quick up vs-admin
ping -c 3 10.77.0.1

# 5) Install ADMIN diagnostic client (from repo)
cd /path/to/VS/ADMIN
./INSTALL_ADMIN
cp config/admin.connection.json.example config/admin.connection.json
# Set:
#   "baseUrl": "http://10.77.0.1:3000"
#   "adminToken": "<same API_ADMIN_TOKEN as SERVER>"
#   "server_id": "VS-CORE-01"
# Never use 127.0.0.1 for production private-net ADMIN

# 6) Start ADMIN diagnostic
export VS_SERVER_URL=http://10.77.0.1:3000
export API_ADMIN_TOKEN=<token>
./START_ADMIN --once

# Expect: CONNECTION CONNECTED, real SERVER id / CPU / RAM (not hardcoded)
# Stop SERVER → ADMIN must show DISCONNECTED (not stale LIVE)
```

---

## C) TEST CLIENT

```bash
# On SERVER (if not done):
sudo VS_SERVER_DATA=/var/lib/vs-server ./network/REGISTER_CLIENT_DEVICE 1 VS-CLIENT-0001

# On client device:
# 1) Install WireGuard
# 2) Import issued VS-CLIENT-0001.conf (Endpoint = SERVER public:51820)
# 3) Bring tunnel up; ping 10.77.0.1
# 4) Application auth (device_token from register output):
curl -sS -X POST http://10.77.0.1:3000/api/v1/network/device/auth \
  -H 'content-type: application/json' \
  -d '{"device_id":"VS-CLIENT-0001","device_token":"<token>"}'
# 5) Prove CLIENT cannot hit ADMIN service:
curl -sS http://10.77.0.1:3000/api/v1/network/admin/only \
  -H "x-vs-session: <session_id>"
# Expect 403 ROLE_DENIED
```

CLIENT must never talk to Capital.com directly. CLIENT must never reach ADMIN management APIs.

---

## After physical PASS

Reply with results of A/B/C. Only then continue AAA Admin UI / native Client UI.
