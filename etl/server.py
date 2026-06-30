"""Servicio ETL — envuelve build_data.py en una API mínima.

  GET  /health  → healthcheck para Railway
  POST /run      → ejecuta el ETL (build_data.py) y guarda un snapshot en Postgres.
                   Lo llama el botón "forzar actualización" del dashboard y el cron.

build_data.py se corre como subproceso: cada /run es un proceso fresco (sin estado
residual entre corridas), y no hay que envolver las 1100 líneas en una función.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

import db

app = FastAPI(title="Proper Pauta · ETL")
HERE = Path(__file__).parent
RUN_TIMEOUT_S = int(os.environ.get("ETL_RUN_TIMEOUT", "300"))


@app.get("/health")
def health():
    return {"status": "ok", "service": "etl"}


@app.post("/run")
def run(x_trigger_secret: str = Header(default=None)):
    # Si ETL_TRIGGER_SECRET está seteado, exigirlo (evita que cualquiera dispare el ETL)
    expected = os.environ.get("ETL_TRIGGER_SECRET")
    if expected and x_trigger_secret != expected:
        raise HTTPException(status_code=401, detail="unauthorized")

    t0 = time.time()
    try:
        proc = subprocess.run(
            [sys.executable, "build_data.py"],
            cwd=str(HERE),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(
            status_code=504,
            content={"ok": False, "error": f"ETL excedió {RUN_TIMEOUT_S}s"},
        )

    elapsed = round(time.time() - t0, 1)
    if proc.returncode != 0:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "elapsed_s": elapsed,
                "stderr": proc.stderr[-2000:],
                "stdout": proc.stdout[-1000:],
            },
        )

    generated_at = None
    try:
        latest = db.get_latest("budget")
        generated_at = (latest or {}).get("generated_at")
    except Exception:
        pass

    return {
        "ok": True,
        "elapsed_s": elapsed,
        "generated_at": generated_at,
        "tail": proc.stdout[-400:],
    }
