# Client Control Panel — shareable URL

Double-click **`VS.bat`**. It downloads the latest launcher from GitHub, then
opens a Cloudflare tunnel to **port 18080** (plain Node static+API proxy).

That port is **not Vite**. A health check refuses to open the tunnel if the
response looks like `allowedHosts` / `Blocked request`.

Keep the `VS.bat` window open. Send only the printed `https://….trycloudflare.com`
plus the access code from http://localhost:5173/clients

Admin desk stays local (`http://localhost:5173/`). Do not send that to clients.
