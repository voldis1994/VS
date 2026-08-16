# Old-system

Šeit ir **visa neaktuālā / vēsturiskā** koda bāze.

**Netiek importēta** no produkcijas `SERVER` / `ADMIN` / `CLIENT` runtime.

## Saturs

| Ceļš | Kas tas bija |
|------|----------------|
| `apps/` | Vecais dashboard + control-api symlink |
| `libs/` | C++ Market Reader steks |
| `legacy-review/` | Iepriekšējā “freeze” arhīvs |
| `docs/` | Vecā lowercase dokumentācija |
| `cmake/`, `CMakeLists.txt`, `vcpkg.json` | C++ build |
| `tests/` | C++ testi |
| `tools/` | Palīgrīki (vs-restart u.c.) |
| `deploy/`, `DEPLOY/` | Vecie root deploy ceļi (aktuālais: `SERVER/deploy`) |
| `data/` | Vēsturiski sample/replay dati |
| `START_3_FILES.txt` | Vecais operatora teksts |

## Aktuālā struktūra (repo sakne)

```
SERVER/       # VS CORE — i3
ADMIN/        # VS ADMIN — MSI
CLIENT/       # VS CLIENT — klienti
Old-system/   # viss neaktuālais
DOCS/         # aktuālā dokumentācija
TESTS/        # aktuālie testi
SHARED/       # kopīgie kontrakti
scripts/      # release / build
```

Neizmanto `Old-system` instalācijā uz i3/MSI/CLIENT.
