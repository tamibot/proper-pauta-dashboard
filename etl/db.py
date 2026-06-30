"""Persistencia de snapshots del ETL en el Postgres propio (Railway).

El ETL ya no escribe data.json a disco — guarda el dict completo de salida como
un snapshot JSONB. El servicio web (Next.js + Prisma) lee el último snapshot.

La tabla `snapshots` la define Prisma (web/prisma/schema.prisma) con @@map a
snake_case para que este lado SQL sea limpio. ensure_schema() crea la tabla si
no existe, de modo que el ETL pueda correr aunque Prisma migrate no haya pasado.
"""
import json
import os
from datetime import datetime, timezone

import psycopg2

DDL = """
CREATE TABLE IF NOT EXISTS snapshots (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'budget',
  generated_at TIMESTAMPTZ NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_kind_created_idx
  ON snapshots (kind, created_at DESC);
"""


def _conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL no está seteada")
    return psycopg2.connect(url)


def ensure_schema():
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(DDL)
        c.commit()


def save_snapshot(payload, kind="budget"):
    """Inserta el dict de salida del ETL como un snapshot. Devuelve el id nuevo."""
    generated_at = payload.get("generated_at") or datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO snapshots (kind, generated_at, payload) "
                "VALUES (%s, %s, %s::jsonb) RETURNING id",
                (kind, generated_at, json.dumps(payload, ensure_ascii=False)),
            )
            new_id = cur.fetchone()[0]
        c.commit()
    return new_id


def get_latest(kind="budget"):
    """Devuelve el payload del último snapshot (para debug / verificación)."""
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(
                "SELECT payload FROM snapshots WHERE kind = %s "
                "ORDER BY created_at DESC LIMIT 1",
                (kind,),
            )
            row = cur.fetchone()
    return row[0] if row else None
