# VS — QUICK START

## Struktūra

```
SERVER/       # VS CORE (i3 Debian) — smadzenes
ADMIN/        # VS ADMIN (MSI) — tikai vadība
CLIENT/       # VS CLIENT — WireGuard klienti
Old-system/   # visa neaktuālā / vēsturiskā koda bāze
DOCS/         # aktuālā dokumentācija
TESTS/        # aktuālie testi
SHARED/       # kopīgie API kontrakti
scripts/      # release skripti
```

## SERVER / i3

```bash
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/install/HEALTHCHECK.sh
sudo bash SERVER/SHOW_DASHBOARD_V2.sh
```

## ADMIN / MSI

```bat
ADMIN\windows\INSTALL_ADMIN.bat
ADMIN\windows\START_ADMIN.bat
```

## CLIENT

```bat
CLIENT\windows\INSTALL_CLIENT.bat
CLIENT\VERIFY_CLIENT.bat
```

**LIVE tirdzniecība pēc noklusējuma IZSLĒGTA.** Bez viltota READY.  
Detalizācija: `DOCS/`, `Old-system/README.md`.
