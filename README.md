# Proper · Dashboard de Inversión en Pauta

Dashboard **interno** con métricas de inversión publicitaria (Meta Ads + Google Ads) y leads de las landings de Proper. Antes era un sitio estático en GitHub Pages; ahora es una **web funcional desplegada en Railway** con datos auto-actualizables.

> El dashboard estático viejo quedó archivado en [`legacy/`](./legacy).

## Arquitectura

```
  Navegador
     │
     ▼
 ┌─────────────┐   /api/refresh   ┌─────────────┐   SQL vía webhook   ┌──────────┐
 │   web       │ ───────────────▶ │   etl       │ ──────────────────▶ │  n8n     │ ─▶ RDS (bitrix.*)
 │ Next.js 15  │                  │  FastAPI    │   Meta Ads API ─────▶│ rds-proxy│
 │ + Prisma    │ ◀─────────────── │ build_data  │   Google Ads API ───▶└──────────┘
 └──────┬──────┘   lee snapshot   └──────┬──────┘
        │                                │ guarda snapshot (JSONB)
        ▼                                ▼
   ┌──────────────────── Postgres (Railway) ────────────────────┐
   │  tabla `snapshots` (kind, generated_at, payload JSONB)      │
   └─────────────────────────────────────────────────────────────┘
```

- **`web/`** — Next.js 15 + Prisma. Sirve el dashboard. `GET /api/data` lee el último snapshot; `POST /api/refresh` dispara el ETL y re-lee.
- **`etl/`** — FastAPI. `POST /run` corre `build_data.py` (subproceso): consulta el RDS de Bitrix (vía n8n), la API de Meta Ads y la de Google Ads, y guarda el resultado como un snapshot JSONB en Postgres. `GET /health` para el healthcheck.
- **`n8n/`** — workflow `rds-proxy` que se importa en la instancia n8n. El ETL **no** toca el RDS directo (solo n8n está allowlisteado en el RDS): manda el SQL por webhook y n8n lo ejecuta.
- **Postgres** (servicio Railway) — guarda los snapshots. La tabla la crea el propio ETL (`db.ensure_schema()`), no hace falta `prisma migrate`.

## Estructura del repo

```
.
├── etl/          # ETL FastAPI (build_data.py, server.py, db.py, n8n_client.py, railway.json)
├── web/          # Next.js 15 + Prisma (app/, lib/, prisma/, railway.json)
├── n8n/          # rds-proxy-workflow.json (importar en n8n)
├── legacy/       # dashboard estático viejo (referencia)
└── README.md
```

## Deploy en Railway

Proyecto **`proper-pauta-dashboard`** (workspace *tamibot's Projects*), entorno `production`. Dos servicios desde **este mismo repo** (monorepo con root directories) + un Postgres:

| Servicio | Root Directory | Build/Start |
|---|---|---|
| `etl` | `etl` | NIXPACKS · `gunicorn server:app -k uvicorn.workers.UvicornWorker` (ver `etl/railway.json`) |
| `web` | `web` | NIXPACKS · `npm run start` (ver `web/railway.json`) |
| `Postgres` | — | imagen managed de Railway |

El **auto-deploy** se dispara al hacer push a `main`. Conviene setear *Watch Paths* (`etl/**` y `web/**`) para que cada servicio redeploye solo cuando cambia su carpeta.

### Variables de entorno

No se commitean — se setean como variables en Railway. Ver los templates:
- **`etl/.env.example`** — `DATABASE_URL`, `N8N_WEBHOOK_URL`, `N8N_PROXY_SECRET`, `META_TOKEN`, `GOOGLE_*`, `ETL_TRIGGER_SECRET`, `USE_N8N=true`.
- **`web/.env.example`** — `DATABASE_URL` (mismo Postgres), `ETL_URL` (URL pública del ETL), `ETL_TRIGGER_SECRET` (igual que el del ETL).

`DATABASE_URL` se referencia con `${{Postgres.DATABASE_URL}}` y `ETL_URL` con `https://${{etl.RAILWAY_PUBLIC_DOMAIN}}`.

### Puesta en marcha

1. Crear los 3 servicios (etl, web, Postgres) y setear las variables.
2. **Importar** `n8n/rds-proxy-workflow.json` en la instancia n8n y activar el webhook (`X-Proxy-Secret` = `N8N_PROXY_SECRET`). El nodo Postgres del workflow apunta al RDS de Bitrix.
3. Deploy. El primer `POST /run` del ETL crea la tabla `snapshots` y el primer snapshot.
4. La web ya muestra los datos en `/`.

## Desarrollo local

```bash
# ETL
cd etl && pip install -r requirements.txt
cp .env.example .env   # completar valores
uvicorn server:app --reload

# Web
cd web && npm install
cp .env.example .env.local   # completar valores
npm run dev
```

## Notas

- El código fuente original vivía en `proper-ia/dashboards/app/`; este repo es ahora la **fuente de verdad** del dashboard.
- ⚠️ La web no tiene autenticación todavía — si va a quedar accesible públicamente, conviene agregar control de acceso.
