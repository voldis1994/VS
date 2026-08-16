# CLIENT install (remote Windows)

1. ADMIN creates enrollment (device + WireGuard peer).  
2. Deliver enrollment package securely.  
3. On client PC:

```bat
CLIENT\windows\INSTALL_CLIENT.bat
CLIENT\VERIFY_CLIENT.bat
CLIENT\windows\START_CLIENT.bat
```

Requires WireGuard. Endpoint must be `PUBLIC_HOST_OR_IP:51820` (not LAN IP across ISPs).

Client never holds Capital credentials, ADMIN token, or server WG private key.

START = strategy participation enabled (not immediate BUY).  
STOP = block new strategy-originated exposure (does not silently close LIVE positions).
