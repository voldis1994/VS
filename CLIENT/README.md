# CLIENT

Windows customer application for VS CORE.

## Layout

```
CLIENT/
  desktop/     React UI (HOME / POSITIONS / HISTORY / SETTINGS)
  connection/  Enrollment helper (device enroll against Network Authority)
  windows/     INSTALL / START / STOP / STATUS / VERIFY
```

## Install

1. Obtain enrollment package from ADMIN (one-time code + WG config)
2. `CLIENT\windows\INSTALL_CLIENT.bat`
3. `CLIENT\START_CLIENT.bat`
4. `CLIENT\VERIFY_CLIENT.bat`

Customer packaged release must ship prebuilt UI / `VS_CLIENT_SETUP.exe` (see `scripts/BUILD_CLIENT_PACKAGE.sh`).

## START / STOP

START calls `POST /api/v1/trading/start` on the CLIENT API (WireGuard `10.77.0.1`).
It does **not** place an instant market order.

## States

VPN connected ≠ APP connected. App heartbeat uses `/api/v1/network/device/heartbeat`.
