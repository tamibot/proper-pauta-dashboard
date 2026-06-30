"""Shim que reemplaza un cursor psycopg2 por llamadas HTTP a un webhook de n8n.

Por qué existe: el RDS de AWS (workshop-data) solo acepta conexiones de IPs
allowlistadas. El n8n de Railway YA está en ese allowlist, así que en vez de
conectar directo con psycopg2 (que fallaría desde un servicio nuevo en Railway),
enrutamos cada query SQL por un webhook de n8n que la ejecuta contra el RDS y
devuelve las filas como JSON.

N8nCursor emula la interfaz mínima de psycopg2 que usa build_data.py
(execute / fetchall / fetchone / close), de modo que el resto del ETL no cambia.

Detalles importantes:
  - El ETL hace `cur.execute(sql, (since, until))` con placeholders `%s` y
    escapes de LIKE `%%`. Acá interpolamos los params de forma segura (son
    fechas ISO internas, NO input de usuario) y normalizamos `%%` → `%`.
  - El código consume las filas POSICIONALMENTE (`for fecha, cat, leads in rows`
    y por índice `r[0]`). n8n devuelve objetos JSON; los convertimos a tuplas
    preservando el orden de columnas del SELECT.
  - Columnas `::date` llegan como strings ISO; las reconstruimos a `date` para
    que `fecha.isoformat()` siga funcionando igual que con psycopg2.
"""
import json
import re
import ssl
import urllib.request
from datetime import date

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$")


def _quote(v):
    """Quote a param value for safe inline interpolation (internal dates only)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    # string → escape single quotes
    return "'" + str(v).replace("'", "''") + "'"


def interpolate(sql, params):
    """Replace %s placeholders with quoted params, then unescape %% → %.

    Order matters: we split on the literal '%s' first (params never contain it),
    then collapse the LIKE escapes '%%' → '%'. Params here are always ISO date
    strings generated internally, so inline interpolation is safe.
    """
    if params:
        parts = sql.split("%s")
        if len(parts) - 1 != len(params):
            raise ValueError(
                f"placeholder count ({len(parts) - 1}) != params ({len(params)})"
            )
        out = parts[0]
        for value, tail in zip(params, parts[1:]):
            out += _quote(value) + tail
        sql = out
    return sql.replace("%%", "%")


def _coerce(v):
    """Reconstruct dates from ISO strings so downstream .isoformat() works.

    Only strings that look like a full ISO date are converted; canal names,
    categories, campaign names, etc. never match the pattern.
    """
    if isinstance(v, str) and _ISO_DATE_RE.match(v):
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return v
    return v


def _row_to_tuple(row):
    """Convert an n8n row object to a positional tuple.

    Postgres preserves SELECT column order, and JSON / json.loads preserve key
    insertion order, so dict.values() yields columns in the right order.
    """
    if isinstance(row, dict):
        return tuple(_coerce(v) for v in row.values())
    if isinstance(row, (list, tuple)):
        return tuple(_coerce(v) for v in row)
    return (row,)


class N8nCursor:
    """Minimal psycopg2-cursor-compatible object backed by an n8n webhook."""

    def __init__(self, webhook_url, secret=None, timeout=120):
        if not webhook_url:
            raise ValueError("N8N_WEBHOOK_URL is required")
        self.webhook_url = webhook_url
        self.secret = secret
        self.timeout = timeout
        self._rows = []
        self._ctx = ssl.create_default_context()

    def execute(self, sql, params=None):
        final_sql = interpolate(sql, params)
        self._rows = self._post(final_sql)
        return self

    def fetchall(self):
        return [_row_to_tuple(r) for r in self._rows]

    def fetchone(self):
        return _row_to_tuple(self._rows[0]) if self._rows else None

    def close(self):
        self._rows = []

    # context-manager friendliness (build_data.py doesn't use it, but harmless)
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _post(self, sql):
        body = json.dumps({"query": sql}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.secret:
            headers["X-Proxy-Secret"] = self.secret
        req = urllib.request.Request(
            self.webhook_url, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as r:
            payload = json.loads(r.read().decode("utf-8"))
        return _extract_rows(payload)


def _extract_rows(payload):
    """Normalize n8n's response into a list of row dicts.

    Accepts several shapes n8n might return:
      - [ {col: val, ...}, ... ]                 (direct rows)
      - { "rows": [ ... ] }                       (wrapped)
      - { "data": [ ... ] }                       (wrapped)
      - [ { "json": { ... } }, ... ]              (n8n item envelope)
    """
    if isinstance(payload, dict):
        for key in ("rows", "data", "result"):
            if key in payload and isinstance(payload[key], list):
                payload = payload[key]
                break
        else:
            # single object → treat as one row
            return [payload]
    if not isinstance(payload, list):
        return []
    # unwrap n8n item envelope {"json": {...}} if present
    out = []
    for item in payload:
        if isinstance(item, dict) and set(item.keys()) == {"json"} and isinstance(item["json"], dict):
            out.append(item["json"])
        else:
            out.append(item)
    return out


class N8nConnection:
    """Stand-in for a psycopg2 connection. Only provides cursor() and close()."""

    def __init__(self, webhook_url, secret=None, timeout=120):
        self.webhook_url = webhook_url
        self.secret = secret
        self.timeout = timeout

    def cursor(self):
        return N8nCursor(self.webhook_url, self.secret, self.timeout)

    def close(self):
        pass
