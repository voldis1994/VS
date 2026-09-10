# VS.bat — vienīgais palaišanas fails (VS MASTER)

Dubultklikšķis uz **`VS.bat`** (VS mapes saknē).

1. Aptur veco sistēmu (Vite, API, **PC-Control / B.O.S.S. :5050**)
2. `git pull` jaunāko **main**
3. Iestata MASTER env (`MASTER_OWNS_PIPELINE=true`, `MASTER_AUTO_START=true`)
4. Palaiž Docker, control-api, dashboard, client panel, market-core
5. Atver **http://localhost:5173/master** (ne `/robot`)
6. **Šajā pašā logā** atver klienta Cloudflare tuneli

**Neaizver to logu.**

## Ko atvērt

| Kas | URL |
|-----|-----|
| **VS MASTER** (operators) | http://localhost:5173/master |
| Klienta panelis (lokāli) | http://127.0.0.1:18080 |
| Klientam sūtīt | `https://….trycloudflare.com` + access code |

**Ne** `localhost:5173/robot` un **ne** B.O.S.S. / PC-Control — tas ir vecais ceļš.

## PAPER vs LIVE

- **PAPER:** automātiski pēc VS.bat (`MASTER_AUTO_START=true`, `MASTER_MODE=PAPER`)
- **LIVE gate:** VS.bat iestata `MASTER_LIVE_ENABLED=true` (vairs nav “LIVE blocked”)
- **LIVE fills:** Master → **CAPITAL PROBE** → **ATTACH CAPITAL** → **START LIVE**
  (vajag Brokers `capital_com` vai `CAPITAL_*` `.env`)

Ja vecajā `.env` vēl ir `MASTER_LIVE_ENABLED=false`, VS.bat to **pārraksta uz true**.

## Piezīme

`VS.bat` sākumā ņem launcher no GitHub `main` (lai vecs fails diskā nespētu atvērt Vite tuneli). Tāpēc MASTER izmaiņām jābūt uz `main`.

## Klienti (MASTER fanout)

Kad MASTER ir **Owns ON** un LIVE/PAPER strādā, `CLIENT FANOUT: no_subscribers` nozīmē, ka neviens klients nav abonējis OPEN kopēšanu.

Lai pievienotu klientu fanout:

1. **Clients** — kontam jābūt Enabled + Access On + Capital broker + markets pulled
2. Izvēlies to pašu tirgu kā MASTER (piem. **GOLD**) un lot size (Clients panelī vai Client Control)
3. Vai nu:
   - Admin: **SUBSCRIBE FANOUT** pogu Clients lapā
   - Vai Client Control: **TAP TO START** (kad MASTER Owns ON = subscribe, nevis own-brain)
4. Nākamajā MASTER OPEN `CLIENT FANOUT` rādīs `ok=N/N` nevis `no_subscribers`

**Piezīme:** Own-brain START ir bloķēts kamēr Owns ON — tas ir paredzēts (viens smadzeņu ceļš). Fanout ir pareizais multi-account režīms.

