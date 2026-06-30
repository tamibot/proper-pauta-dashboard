# Inversión en Pauta — Dashboard

Dashboard estático con métricas diarias de inversión publicitaria de Proper (Meta Ads + Google Ads) y leads de la landing de inversiones.

**Live:** https://tamibot.github.io/proper-pauta-dashboard/

## Stack
- HTML + Tailwind (CDN) + Chart.js (CDN) — sin build step
- `data.json` regenerado periódicamente desde un script offline (no incluido aquí — está en el repo privado del backend)

## Filtros
- Rango: 7 / 14 / 30 / 60 días o Mes en curso
- Tooltips detallados al hover
- Tabla ordenable
