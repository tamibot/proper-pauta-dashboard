# CLAUDE.md — proper-pauta-dashboard

Repo **fuente de verdad** del dashboard interno de inversión en pauta de Proper. Migrado de sitio estático (GitHub Pages) a web funcional en **Railway**. Leé el `README.md` para la arquitectura completa.

## Layout
- `etl/` — FastAPI. `POST /run` corre `build_data.py` → snapshot JSONB en Postgres. `GET /health`.
- `web/` — Next.js 15 + Prisma. `/api/data` (lee snapshot), `/api/refresh` (dispara ETL).
- `n8n/` — workflow `rds-proxy` (importar en la instancia n8n).
- `legacy/` — dashboard estático viejo (no tocar; referencia).

## Cableado crítico
- El ETL **no** consulta el RDS directo — el RDS solo allowlistea a **n8n**. `build_data.py` manda el SQL por webhook (`N8N_WEBHOOK_URL`, header `X-Proxy-Secret`=`N8N_PROXY_SECRET`). Flag `USE_N8N` (true en prod). El n8n vive en el proyecto Railway `proper-grateful-communication` (servicio Primary = `primary-production-0299.up.railway.app`).
- La tabla `snapshots` la crea el ETL (`db.ensure_schema()`), no Prisma migrate.
- Secrets (Meta/Google/n8n/RDS) van como **variables en Railway**, nunca en el repo. Ver `etl/.env.example` y `web/.env.example`.

## Railway
- Proyecto `proper-pauta-dashboard` · workspace *tamibot's Projects* · entorno `production`.
- Servicios: `etl` (root `etl/`), `web` (root `web/`), `Postgres`. Auto-deploy en push a `main` (setear Watch Paths `etl/**`, `web/**`).

## Convenciones
- NO commitear `.env`, `node_modules/`, `.next/`.
- Si tocás cómo se **calculan** los datos → `etl/build_data.py`. Si tocás cómo se **ven** → `web/app/page.tsx` + `web/lib/budget.ts`.
- Tope de budget y lógica de Inversiones/Rentas viven en `web/lib/budget.ts` y `etl/build_data.py`.

## Pendientes conocidos
- La web no tiene auth — agregar control de acceso si queda pública.
- Rotar los tokens Meta/Google (estuvieron hardcodeados en el ETL viejo de `proper-ia`).
