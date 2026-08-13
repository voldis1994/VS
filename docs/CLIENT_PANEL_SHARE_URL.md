# Client Control Panel — shareable URL

Double-click **`VS.bat`**.

The **same window** prints:

```text
https://….trycloudflare.com
```

Send that URL + access code (admin `http://localhost:5173/clients`) to the client.

Keep `VS.bat` window open. The tunnel points at Control API `:3000` (static client panel), not Vite. LAN IPs (`192.168…`) do not work for remote clients.
