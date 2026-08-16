# VS Legacy / Old-system Audit

**Date:** 2026-08-16  

## Saknes struktūra

| Mape | Statuss |
|------|---------|
| `SERVER/` | AKTUĀLS — VS CORE |
| `ADMIN/` | AKTUĀLS — VS ADMIN |
| `CLIENT/` | AKTUĀLS — VS CLIENT |
| `Old-system/` | NEAKTUĀLS — viss vēsturiskais |
| `DOCS/`, `TESTS/`, `SHARED/`, `scripts/` | AKTUĀLS atbalsts |

## Kas pārcelts uz `Old-system/`

`apps/`, `libs/`, `legacy-review/`, `docs/`, `cmake/`, CMake faili, `tests/`, `tools/`, `deploy/`, `DEPLOY/`, `data/`, `vcpkg.json`, `START_3_FILES.txt`

Produkcijas Node runtime **neimportē** `Old-system`.
