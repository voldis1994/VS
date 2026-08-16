# CLIENT — remote web portal (outside home Wi‑Fi)

Customers are **not** on your home Wi‑Fi. They need:

1. **WireGuard** tunnel to i3  
2. Then browser → `http://10.77.0.1:3000/`  
3. Login + password from ADMIN  
4. Select **market** + **lot size** → START/STOP robot  

## ADMIN (MSI)

1. `ADMIN\START_ADMIN.bat`  
2. **CLIENTS** → enter login name → **CREATE REMOTE CLIENT**  
3. Copy once:
   - Login / Password  
   - WireGuard enrollment code  
   - Remote URL: `http://10.77.0.1:3000/`  

4. Link a Capital/broker account to that client (otherwise market list is empty).

## Customer PC

1. Install WireGuard  
2. Complete enrollment with the code (e.g. `CLIENT\windows\INSTALL_CLIENT.bat`)  
3. Open `http://10.77.0.1:3000/`  
4. Sign in → choose market → set lot → START  

## i3 network (required for remote)

```bash
# Public hostname or IP for WireGuard endpoint
# In /var/lib/vs-server/server.env:
PUBLIC_HOST_OR_IP=your.ddns.example
VS_SERVER_ENDPOINT_HOSTNAME=your.ddns.example
```

Router: forward **UDP 51820** → i3.

If CGNAT blocks inbound UDP, remote WireGuard is **BLOCKED** until you have a public endpoint (VPS relay / different ISP / etc.).

## LAN-only test

Same Wi‑Fi as i3: `http://<i3-LAN-IP>:3000/` (no WG). Real customers outside Wi‑Fi must use VPN URL.
