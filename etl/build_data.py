#!/usr/bin/env python3
"""Genera data.json alineado con el Lambda Reporte Landing.

Fuentes (orden de verdad):
  1. bitrix.hs_deals filtrado a LANDING via utm_campaign LIKE '%landing%' →
       leads, aprobados, categoría (ALTO/MEDIO/EMPUJE/APROBADO INTERNACIONAL/NO APROBADO),
       canal (utm_source), campaña (utm_campaign), conjunto (utm_medium), término (utm_term).
  2. Meta Ads Insights API → spend Meta diario por campaña / adset / ad.
  3. Google Ads API        → spend Google diario por campaña / asset group.

Rango: últimos 60 días.
"""
import os
import psycopg2, json, urllib.request, urllib.parse, ssl, re
from datetime import datetime, date, timedelta, timezone
from pathlib import Path

# Shim que enruta las queries del RDS por n8n (ya allowlistado) + persistencia
from n8n_client import N8nConnection
import db

# ============================================================
# Clasificador de campañas Meta — confirmado con usuario 2026-05-26
# Categorías: inv (Inversiones), ren (Rentas), modo (MODO), otro
# Solo INV y REN cuentan en el budget S/9,300 del usuario.
# MODO y otro se excluyen del Presupuesto (aunque tienen spend).
#
# Estrategia: mapping por ID (inmutable) + heurística por nombre como
# fallback para campañas nuevas no registradas. Cuando aparezcan campañas
# nuevas, idealmente agregar el ID a este dict para ser explícitos.
# ============================================================
CAMPAIGN_ID_TO_CATEGORY = {
    # Inversiones
    '120242729618090351': 'inv',  # IN-LANDING-FROM-ABR-2026
    '120235973949050351': 'inv',  # Campaña-IN-NOV-25-V3
    '120239542051840351': 'inv',  # Campaña-IN-ENE-26-FULL
    '120244074583750351': 'inv',  # IN-LANDING-FROM-ABR-2026 -  ABO
    '120241448263110351': 'inv',  # CAMPAÑA-IN-MAR26-TOP-ANUNCIOS-DM-IG
    '120240356547640351': 'inv',  # Campaña-IN-FEBRERO-26 - V2
    '120241770520130351': 'inv',  # CAMPAÑA-IN-MAR26-DM-IG
    '120242149933950351': 'inv',  # Leads - Landing Proper Inversiones MAR26
    '120239380865880351': 'inv',  # Campaña-IN-ENE-2026
    '120240816288900351': 'inv',  # IN-FEB-26-WPP
    '120241172655640351': 'inv',  # Campaña-IN-MAR-26
    '120241442088130351': 'inv',  # Campaña-IN-NOV-25-V3-MAR26-FORM
    '120241448723480351': 'inv',  # CAMPAÑA-IN-MAR26-TOP-ANUNCIOS - WPP
    '120240988461330351': 'inv',  # Campaña-IN-FEBRERO-26 - FORMULARIO - Copia
    '120241364719030351': 'inv',  # Campaña-IN-MAR-26 - V2
    '120240872858250351': 'inv',  # Campaña-IN-FEBRERO-26 - FORMULARIO
    '120239514476110351': 'inv',  # Campaña-IN-ENE-2026-BOT
    '120240276510130351': 'inv',  # Campaña-IN-FEBRERO-26
    '120243156348550351': 'inv',  # LookALike2%_IN_clientesinversiones v3 - LANDING
    '120241442954110351': 'inv',  # Campaña-IN-NOV-25-V3 - MAR26 - WPP
    '120242149628640351': 'inv',  # Sales - Landing Proper 24.03
    # Rentas
    '120243246108700351': 'ren',  # Campaña_RENTAS_PROP_ABRIL2026_2
    '120239953879410351': 'ren',  # Campaña_RENTAS_PROP_FEB26
    '120241434419120351': 'ren',  # Campaña_RENTAS_PROP_MAR26
    '120244725599310351': 'ren',  # Campaña_RENTAS_PROP_ABRIL2026_2 - Copy
    '120242551628850351': 'ren',  # Campaña_RENTAS_PROP_ABRIL2026
    # MODO (excluidas del budget)
    '120236837189530351': 'modo',  # MODO-NOV-2025-FORM
    '120243082193290351': 'modo',  # MODO-ABRIL-26-FORM
    # Otro / proyecto separado (excluidas del budget)
    '120238733955790351': 'otro',  # ARISE-DIC-FORM
}

def classify_campaign(campaign_id, campaign_name=None):
    """Clasifica una campaña Meta. Usa ID primero (inmutable), nombre como fallback.
    Para campañas nuevas que no están en el mapping, aplica heurística por nombre."""
    if campaign_id and campaign_id in CAMPAIGN_ID_TO_CATEGORY:
        return CAMPAIGN_ID_TO_CATEGORY[campaign_id]
    # Fallback: heurística por nombre (para campañas nuevas no registradas)
    if not campaign_name: return 'otro'
    n = campaign_name.upper()
    if 'MODO' in n: return 'modo'
    if 'ARISE' in n: return 'otro'
    if 'RENTA' in n: return 'ren'
    if 'LANDING' in n: return 'inv'
    if re.search(r'\bIN-', n): return 'inv'
    if '_IN_' in n: return 'inv'
    if 'CAMPAÑA-IN' in n or 'CAMPANA-IN' in n: return 'inv'
    return 'otro'

HERE = Path(__file__).parent

# --- Config desde el entorno, con fallback al archivo de credenciales (debug local) ---
def _load_env_file():
    f = HERE.parent.parent.parent / 'credenciales' / 'lambda-reporte-ventas.env'
    env = {}
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k, v = line.split('=', 1); env[k.strip()] = v.strip()
    return env

_file_env = _load_env_file()
def cfg(key, default=None):
    return os.environ.get(key) or _file_env.get(key) or default

USE_N8N = (os.environ.get('USE_N8N', 'true').lower() == 'true')
WRITE_DATA_JSON = (os.environ.get('WRITE_DATA_JSON', 'false').lower() == 'true')

today = date.today()
since = (today - timedelta(days=60)).isoformat()
until = today.isoformat()
print(f"Rango: {since} → {until}  ·  RDS: {'n8n proxy' if USE_N8N else 'psycopg2 directo'}")

ctx = ssl.create_default_context()
META_TOKEN = cfg('META_TOKEN')
if not META_TOKEN:
    raise RuntimeError("META_TOKEN no configurado (env var o credenciales/lambda-reporte-ventas.env)")

# ============================================================
# 1) BITRIX (hs_deals) — fuente de verdad de leads + clasificación
# ============================================================
print("→ Bitrix hs_deals (filtro: utm_campaign LIKE '%landing%')...")
if USE_N8N:
    # Queries al RDS vía webhook n8n (n8n ya está allowlistado en el RDS)
    conn = N8nConnection(cfg('N8N_WEBHOOK_URL'), cfg('N8N_PROXY_SECRET'))
    cur = conn.cursor()
else:
    # Debug local: conexión directa al RDS (requiere IP allowlisted)
    _rds = cfg('RDS_DATABASE_URL')
    if _rds:
        conn = psycopg2.connect(_rds)
    else:
        conn = psycopg2.connect(host=cfg('DB_HOST'), dbname=cfg('DB_NAME'), user=cfg('DB_USER'),
                                password=cfg('DB_PASSWORD'), port=int(cfg('DB_PORT', 5432)))
    cur = conn.cursor()

CANAL_CASE = """
  CASE
    WHEN LOWER(utm_source) IN ('fb','facebook')                  THEN 'Facebook'
    WHEN LOWER(utm_source) IN ('ig','instagram','ig_dm')         THEN 'Instagram'
    WHEN LOWER(utm_source) IN ('an','audience_network')          THEN 'Audience Network'
    WHEN LOWER(utm_source) IN ('google','adwords','gclid','goog') THEN 'Google'
    ELSE COALESCE(utm_source, 'Sin origen')
  END
"""
# Buckets de categoriacliente (alineados con UF_CRM_1711043847 del Lambda)
CAT_KEY = """
  CASE
    WHEN categoriacliente = 'ALTO'                     THEN 'alto'
    WHEN categoriacliente = 'MEDIO'                    THEN 'medio'
    WHEN categoriacliente = 'EMPUJE'                   THEN 'empuje'
    WHEN categoriacliente = 'APROBADO INTERNACIONAL'   THEN 'aprobado_int'
    WHEN categoriacliente = 'NO APROBADO NACIONAL'     THEN 'no_aprobado_nac'
    WHEN categoriacliente = 'NO APROBADO INTERNACIONAL'THEN 'no_aprobado_int'
    ELSE 'sin_clasificar'
  END
"""

# Q1: por día (totales globales + por categoría)
cur.execute(f"""
  SELECT
    fechacreacion::date AS fecha,
    {CAT_KEY} AS cat,
    count(*)::int AS leads
  FROM bitrix.hs_deals
  WHERE fechacreacion >= %s AND fechacreacion <= %s
    AND LOWER(utm_campaign) LIKE '%%landing%%'
  GROUP BY 1, 2
""", (since, until))
rows_day_cat = cur.fetchall()

# Q2: por día y canal
cur.execute(f"""
  SELECT
    fechacreacion::date AS fecha,
    {CANAL_CASE} AS canal,
    {CAT_KEY} AS cat,
    count(*)::int AS leads
  FROM bitrix.hs_deals
  WHERE fechacreacion >= %s AND fechacreacion <= %s
    AND LOWER(utm_campaign) LIKE '%%landing%%'
  GROUP BY 1, 2, 3
""", (since, until))
rows_day_canal_cat = cur.fetchall()

# Q3: por campaña + conjunto (utm_campaign + utm_medium). hs_deals NO tiene utm_term/utm_content
# El ad-name viene de Meta API
cur.execute(f"""
  SELECT
    COALESCE(utm_campaign, '—')                  AS campaign,
    COALESCE(utm_medium, '—')                    AS adset,
    {CANAL_CASE}                                 AS canal,
    count(*)::int                                AS leads,
    sum(CASE WHEN categoriacliente IN ('ALTO','MEDIO','EMPUJE','APROBADO INTERNACIONAL') THEN 1 ELSE 0 END)::int AS aprobados,
    sum(CASE WHEN categoriacliente='ALTO'   THEN 1 ELSE 0 END)::int AS alto,
    sum(CASE WHEN categoriacliente='MEDIO'  THEN 1 ELSE 0 END)::int AS medio,
    sum(CASE WHEN categoriacliente='EMPUJE' THEN 1 ELSE 0 END)::int AS empuje
  FROM bitrix.hs_deals
  WHERE fechacreacion >= %s AND fechacreacion <= %s
    AND LOWER(utm_campaign) LIKE '%%landing%%'
  GROUP BY 1, 2, 3
""", (since, until))
rows_camp_breakdown = cur.fetchall()

# Pivot Q1 → {fecha: {alto, medio, empuje, ...}}
day_totals = {}
for fecha, cat, leads in rows_day_cat:
    ds = fecha.isoformat()
    if ds not in day_totals:
        day_totals[ds] = {'alto':0,'medio':0,'empuje':0,'aprobado_int':0,
                          'no_aprobado_nac':0,'no_aprobado_int':0,'sin_clasificar':0}
    day_totals[ds][cat] = leads

# Pivot Q2 → {fecha: {canal: {leads, aprobados, alto, ...}}}
day_canal = {}
for fecha, canal, cat, leads in rows_day_canal_cat:
    ds = fecha.isoformat()
    if ds not in day_canal: day_canal[ds] = {}
    if canal not in day_canal[ds]:
        day_canal[ds][canal] = {'leads':0,'aprobados':0,'alto':0,'medio':0,'empuje':0,
                                'aprobado_int':0,'no_aprobado_nac':0,'no_aprobado_int':0,'sin_clasificar':0}
    rec = day_canal[ds][canal]
    rec['leads'] += leads
    rec[cat] += leads
    if cat in ('alto','medio','empuje','aprobado_int'):
        rec['aprobados'] += leads

print(f"   ✓ {len(rows_day_cat)} day-cat rows · {len(rows_day_canal_cat)} day-canal-cat · {len(rows_camp_breakdown)} camp breakdown")

# ============================================================
# 1b) Funnel: asistentes, simulados, cotizados, reuniones_agendadas
# ============================================================
print("→ Funnel metrics: asistentes/simulados/cotizados/reuniones_agendadas...")

# Asistentes por día y canal (replica lógica del Query Diario base)
cur.execute(f"""
  WITH participantes AS (
    SELECT DISTINCT a.id, a.fecha, a.email
    FROM bitrix.participantes a
    LEFT JOIN (SELECT DISTINCT id FROM bitrix.inscritos) c ON a.id = c.id
    WHERE c.id IS NULL AND a.email NOT ILIKE '%%proper%%'
  ),
  reuniones_total AS (
    SELECT fecha, email, 'SI'::text AS asistio FROM participantes
    UNION ALL
    SELECT fecha, email, asistio FROM bitrix.temp_reuniones_semanales WHERE email NOT ILIKE '%%proper%%'
  ),
  joined AS (
    SELECT
      r.fecha::date AS d,
      {CANAL_CASE.replace('utm_source', 'h.utm_source')} AS canal,
      r.email
    FROM reuniones_total r
    LEFT JOIN bitrix.hs_cliente cli ON LOWER(cli.email) = LOWER(r.email)
    LEFT JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY idcliente ORDER BY fechacreacion DESC) AS rn
      FROM bitrix.hs_deals WHERE LOWER(utm_campaign) LIKE '%%landing%%'
    ) h ON cli.id = h.idcliente AND h.rn=1
    WHERE r.asistio='SI' AND r.fecha::date >= %s AND r.fecha::date <= %s
  )
  SELECT d, canal, count(DISTINCT email)::int FROM joined GROUP BY 1, 2
""", (since, until))
rows_asistentes = cur.fetchall()

# Simulados (financiamiento_cliente) por día + canal — match por dni en hs_deals
cur.execute(f"""
  WITH sims AS (
    SELECT fc.fecha::date AS d, fc.dni
    FROM financiamiento_cliente fc
    WHERE fc.fecha >= %s AND fc.fecha <= %s
  ),
  joined AS (
    SELECT
      s.d,
      {CANAL_CASE.replace('utm_source', 'h.utm_source')} AS canal,
      s.dni
    FROM sims s
    LEFT JOIN bitrix.hs_cliente cli ON cli.nrodoc = s.dni
    LEFT JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY idcliente ORDER BY fechacreacion DESC) AS rn
      FROM bitrix.hs_deals WHERE LOWER(utm_campaign) LIKE '%%landing%%'
    ) h ON cli.id = h.idcliente AND h.rn=1
  )
  SELECT d, canal, count(DISTINCT dni)::int FROM joined GROUP BY 1, 2
""", (since, until))
rows_simulados = cur.fetchall()

# Cotizados (cotizaciones_proyectos) por día + canal
cur.execute(f"""
  WITH cotz AS (
    SELECT cp.fecha::date AS d, cp.dni
    FROM cotizaciones_proyectos cp
    WHERE cp.fecha >= %s AND cp.fecha <= %s
  ),
  joined AS (
    SELECT
      c.d,
      {CANAL_CASE.replace('utm_source', 'h.utm_source')} AS canal,
      c.dni
    FROM cotz c
    LEFT JOIN bitrix.hs_cliente cli ON cli.nrodoc = c.dni
    LEFT JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY idcliente ORDER BY fechacreacion DESC) AS rn
      FROM bitrix.hs_deals WHERE LOWER(utm_campaign) LIKE '%%landing%%'
    ) h ON cli.id = h.idcliente AND h.rn=1
  )
  SELECT d, canal, count(DISTINCT dni)::int FROM joined GROUP BY 1, 2
""", (since, until))
rows_cotizados = cur.fetchall()

print(f"   ✓ asistentes={len(rows_asistentes)} simulados={len(rows_simulados)} cotizados={len(rows_cotizados)}")

# Pivot funnel data → {fecha: {canal: {asistentes, simulados, cotizados}}}
funnel_extra = {}
def _bucket(d, canal, key, value):
    ds = d.isoformat()
    funnel_extra.setdefault(ds, {})
    funnel_extra[ds].setdefault(canal, {'asistentes':0,'simulados':0,'cotizados':0})
    funnel_extra[ds][canal][key] = value

for d, canal, n in rows_asistentes: _bucket(d, canal, 'asistentes', n)
for d, canal, n in rows_simulados:  _bucket(d, canal, 'simulados',  n)
for d, canal, n in rows_cotizados:  _bucket(d, canal, 'cotizados',  n)

conn.close()

# ============================================================
# 2) META API — campaign-level daily (totales spend) + ad-level
# ============================================================
def _meta_paged(url):
    rows = []
    next_url = url
    while next_url:
        with urllib.request.urlopen(next_url, timeout=20, context=ctx) as r:
            payload = json.load(r)
        rows.extend(payload.get('data', []))
        next_url = (payload.get('paging') or {}).get('next')
    return rows

print("→ Meta API (campaign-level daily)...")
url = ("https://graph.facebook.com/v19.0/act_424971935894203/insights"
       "?fields=spend,impressions,reach,clicks,campaign_name"
       "&level=campaign&time_range=" + urllib.parse.quote(json.dumps({"since": since, "until": until}))
       + "&time_increment=1&limit=500&access_token=" + META_TOKEN)
meta_camp_rows = [r for r in _meta_paged(url) if 'LANDING' in (r.get('campaign_name','').upper())]
print(f"   ✓ {len(meta_camp_rows)} rows")

meta_by_date = {}
for r in meta_camp_rows:
    d = r.get('date_start')
    if not d: continue
    meta_by_date.setdefault(d, {'spend':0,'impressions':0,'clicks':0,'reach':0})
    meta_by_date[d]['spend']       += float(r.get('spend', 0))
    meta_by_date[d]['impressions'] += int(r.get('impressions', 0))
    meta_by_date[d]['clicks']      += int(r.get('clicks', 0))
    meta_by_date[d]['reach']       += int(r.get('reach', 0))

print("→ Meta API (ad-level daily — campaign + adset + ad)...")
url = ("https://graph.facebook.com/v19.0/act_424971935894203/insights"
       "?fields=spend,impressions,clicks,campaign_name,adset_name,ad_name"
       "&level=ad&time_range=" + urllib.parse.quote(json.dumps({"since": since, "until": until}))
       + "&time_increment=1&limit=500&access_token=" + META_TOKEN)
meta_ad_rows = [r for r in _meta_paged(url) if 'LANDING' in (r.get('campaign_name','').upper())]
print(f"   ✓ {len(meta_ad_rows)} rows")

meta_ads = [{
    'fecha':       r.get('date_start'),
    'campaign':    r.get('campaign_name', ''),
    'adset':       r.get('adset_name', ''),
    'ad':          r.get('ad_name', ''),
    'spend':       round(float(r.get('spend', 0)), 2),
    'impressions': int(r.get('impressions', 0)),
    'clicks':      int(r.get('clicks', 0)),
} for r in meta_ad_rows]

# ============================================================
# 3) Google Ads API — campaign + asset_group
# ============================================================
print("→ Google Ads API (campaign-level daily)...")
data = urllib.parse.urlencode({
    'refresh_token': cfg('GOOGLE_REFRESH_TOKEN'),
    'client_id': cfg('GOOGLE_CLIENT_ID'),
    'client_secret': cfg('GOOGLE_CLIENT_SECRET'),
    'grant_type': 'refresh_token'
}).encode()
req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data, method='POST',
    headers={'Content-Type':'application/x-www-form-urlencoded'})
with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
    access = json.load(r)['access_token']

def gads_query(query):
    body = json.dumps({'query': query}).encode()
    req = urllib.request.Request(
        'https://googleads.googleapis.com/v20/customers/5145735707/googleAds:searchStream',
        data=body, method='POST',
        headers={'Authorization': f'Bearer {access}', 'developer-token': cfg('GOOGLE_DEVELOPER_TOKEN'),
                 'login-customer-id': cfg('GOOGLE_LOGIN_CUSTOMER_ID', '8961854752'), 'Content-Type':'application/json'})
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        raw = json.load(r)
    results = []
    if isinstance(raw, list):
        for b in raw:
            if 'results' in b: results.extend(b['results'])
    elif 'results' in raw: results = raw['results']
    return results

cq = (f"SELECT segments.date, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks "
      f"FROM campaign WHERE segments.date BETWEEN '{since}' AND '{until}' AND campaign.name LIKE '%LANDING%'")
gads_results = gads_query(cq)
print(f"   ✓ {len(gads_results)} rows campaign-level")

gads_by_date = {}
gads_campaigns = []
for r in gads_results:
    d = (r.get('segments') or {}).get('date')
    m = r.get('metrics') or {}
    if not d: continue
    spend = int(m.get('costMicros', 0)) / 1000000
    impr  = int(m.get('impressions', 0))
    clk   = int(m.get('clicks', 0))
    gads_by_date.setdefault(d, {'spend':0,'impressions':0,'clicks':0})
    gads_by_date[d]['spend']       += spend
    gads_by_date[d]['impressions'] += impr
    gads_by_date[d]['clicks']      += clk
    gads_campaigns.append({
        'fecha': d, 'campaign': (r.get('campaign') or {}).get('name', ''),
        'spend': round(spend, 2), 'impressions': impr, 'clicks': clk
    })

print("→ Google Ads API (asset-group level)...")
try:
    ag = gads_query(f"SELECT segments.date, campaign.name, asset_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks "
                    f"FROM asset_group WHERE segments.date BETWEEN '{since}' AND '{until}' AND campaign.name LIKE '%LANDING%'")
    gads_asset_groups = [{
        'fecha': (r.get('segments') or {}).get('date'),
        'campaign': (r.get('campaign') or {}).get('name', ''),
        'asset_group': (r.get('assetGroup') or {}).get('name', ''),
        'spend': round(int((r.get('metrics') or {}).get('costMicros',0))/1000000, 2),
        'impressions': int((r.get('metrics') or {}).get('impressions',0)),
        'clicks': int((r.get('metrics') or {}).get('clicks',0))
    } for r in ag]
    print(f"   ✓ {len(gads_asset_groups)} rows")
except Exception as e:
    print(f"   ⚠️ {e}")
    gads_asset_groups = []

# ============================================================
# 4) Consolidar timeline diario
# ============================================================
all_dates = sorted(set(list(day_totals) + list(meta_by_date) + list(gads_by_date)))
series = []
for d in all_dates:
    t = day_totals.get(d, {'alto':0,'medio':0,'empuje':0,'aprobado_int':0,'no_aprobado_nac':0,'no_aprobado_int':0,'sin_clasificar':0})
    aprobados   = t['alto'] + t['medio'] + t['empuje'] + t['aprobado_int']
    no_aprobados = t['no_aprobado_nac'] + t['no_aprobado_int']
    leads_total = aprobados + no_aprobados + t['sin_clasificar']

    m = meta_by_date.get(d, {})
    g = gads_by_date.get(d, {})
    meta_spend  = round(m.get('spend', 0), 2)
    gads_spend  = round(g.get('spend', 0), 2)
    total_spend = round(meta_spend + gads_spend, 2)

    cpl     = round(total_spend / leads_total, 2) if leads_total > 0 else None
    cpl_ap  = round(total_spend / aprobados,   2) if aprobados   > 0 else None

    # Funnel extras totales y por canal
    fx = funnel_extra.get(d, {})
    asist_total = sum(v.get('asistentes',0) for v in fx.values())
    simul_total = sum(v.get('simulados',0)  for v in fx.values())
    cotiz_total = sum(v.get('cotizados',0)  for v in fx.values())
    altos_medios = t['alto'] + t['medio']

    # Merge funnel metrics en canales
    canales = day_canal.get(d, {})
    for canal_name, extras in fx.items():
        if canal_name not in canales:
            canales[canal_name] = {'leads':0,'aprobados':0,'alto':0,'medio':0,'empuje':0,
                                   'aprobado_int':0,'no_aprobado_nac':0,'no_aprobado_int':0,'sin_clasificar':0}
        canales[canal_name]['asistentes'] = extras.get('asistentes',0)
        canales[canal_name]['simulados']  = extras.get('simulados', 0)
        canales[canal_name]['cotizados']  = extras.get('cotizados', 0)
    # Asegurar todas las canales tengan los campos (con 0 si no hay datos)
    for canal_name in canales:
        canales[canal_name].setdefault('asistentes', 0)
        canales[canal_name].setdefault('simulados', 0)
        canales[canal_name].setdefault('cotizados', 0)

    series.append({
        'fecha': d,
        'meta_spend': meta_spend, 'gads_spend': gads_spend, 'total_spend': total_spend,
        'meta_impressions': m.get('impressions', 0), 'meta_clicks': m.get('clicks', 0),
        'gads_impressions': g.get('impressions', 0), 'gads_clicks': g.get('clicks', 0),
        'leads': leads_total, 'aprobados': aprobados, 'no_aprobados': no_aprobados,
        'alto': t['alto'], 'medio': t['medio'], 'empuje': t['empuje'],
        'aprobado_int': t['aprobado_int'],
        'no_aprobado_nac': t['no_aprobado_nac'], 'no_aprobado_int': t['no_aprobado_int'],
        'sin_clasificar': t['sin_clasificar'],
        'altos_medios': altos_medios,
        'asistentes': asist_total, 'simulados': simul_total, 'cotizados': cotiz_total,
        'cpl': cpl, 'cpl_aprobado': cpl_ap,
        'canales': canales
    })

# ============================================================
# 5) Campaign breakdown agregado por nivel (campaign / adset / ad)
# ============================================================
# rows_camp_breakdown: (campaign, adset, ad, canal, leads, aprobados, alto, medio, empuje)
postgres_campaigns = [{
    'campaign': r[0], 'adset': r[1], 'canal': r[2],
    'leads': r[3], 'aprobados': r[4],
    'alto': r[5], 'medio': r[6], 'empuje': r[7]
} for r in rows_camp_breakdown]

import calendar
month_start_str = today.replace(day=1).isoformat()
days_in_month = calendar.monthrange(today.year, today.month)[1]
days_elapsed = today.day
month_rows = [r for r in series if r['fecha'] >= month_start_str]
meta_mtd  = round(sum(r['meta_spend']  or 0 for r in month_rows), 2)
gads_mtd  = round(sum(r['gads_spend']  or 0 for r in month_rows), 2)
total_mtd = round(meta_mtd + gads_mtd, 2)
run_rate_daily = round(total_mtd / max(days_elapsed, 1), 2)
projected_eom = round(run_rate_daily * days_in_month, 2)

# Presupuestos PROPER (por canal)
BUDGET_META_PEN     = 6000.0
BUDGET_GOOGLE_PEN   = 1900.0
BUDGET_TIKTOK_PEN   = 500.0
BUDGET_WHATSAPP_PEN = 1800.0
# Presupuesto NOVO 3 (un solo monto total entre todos los canales)
BUDGET_NOVO3_TOTAL  = 1800.0
USD_PEN_RATE        = 3.75     # tipo de cambio referencial para sumar cuentas USD a PEN

# ============================================================
# Helpers para los bloques 4a/4b/4c (Meta accounts, Google total, WABA)
# ============================================================
import time as _time
_month_start_ts = int(_time.mktime(today.replace(day=1).timetuple()))
_now_ts = int(_time.time())
BUSINESS_ID = '111913583845655'  # PropInvest

def _g(url):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {META_TOKEN}'})
    with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
        return json.load(r)

# ============================================================
# 4a) Meta Ads: gasto TOTAL mes en curso por cuenta (todos los accounts del business)
# ============================================================
print("→ Meta Ads (gasto mes en curso por cuenta del business)...")
meta_accounts_mtd = []
meta_accounts_all = []  # para conocer cuentas activas sin gasto
meta_mtd_total_pen = 0.0
try:
    r = _g(f'https://graph.facebook.com/v19.0/{BUSINESS_ID}/owned_ad_accounts?fields=id,name,currency,account_status&limit=50&access_token={META_TOKEN}')
    accounts = r.get('data', [])
    for a in accounts:
        if a.get('account_status') in (101, 100, 2):  # closed/pending_closure/disabled
            continue
        aid = a['id']; aname = a.get('name','?'); acur = a.get('currency','USD')
        try:
            ins = _g(f'https://graph.facebook.com/v19.0/{aid}/insights?date_preset=this_month&fields=spend&access_token={META_TOKEN}')
            spend = float(ins.get('data', [{}])[0].get('spend', 0)) if ins.get('data') else 0.0
        except Exception:
            spend = 0.0
        spend_pen = spend * USD_PEN_RATE if acur != 'PEN' else spend
        meta_mtd_total_pen += spend_pen
        meta_accounts_all.append({
            'id': aid, 'name': aname, 'currency': acur,
            'spend': round(spend, 2), 'spend_pen': round(spend_pen, 2),
        })
        if spend > 0:
            meta_accounts_mtd.append({
                'id': aid, 'name': aname, 'currency': acur,
                'spend': round(spend, 2), 'spend_pen': round(spend_pen, 2),
            })
    meta_accounts_mtd.sort(key=lambda x: x['spend_pen'], reverse=True)
    print(f"   ✓ {len(accounts)} cuentas · {len(meta_accounts_mtd)} con gasto · total PEN {meta_mtd_total_pen:.2f}")
except Exception as e:
    print(f"   ✗ falló: {e}")

# ============================================================
# 4b) Google Ads: gasto TOTAL mes en curso de TODAS las cuentas accesibles
#     - 5145735707  Proper Inversiones - Landing  (vía manager 8961854752)
#     - 3949022627  Proper Rentas                  (acceso directo, sin manager)
#     - 6820069929  ???                            (PERMISSION_DENIED)
# ============================================================
print("→ Google Ads (gasto mes en curso, ambas cuentas)...")
google_mtd_total_pen = 0.0
google_campaigns_mtd = []

def _gads_query_account(cid, query, login=None):
    """Ejecuta una query GAQL en una cuenta específica con header opcional login-customer-id."""
    hdr = {'Authorization': f'Bearer {access}', 'developer-token': cfg('GOOGLE_DEVELOPER_TOKEN'), 'Content-Type':'application/json'}
    if login: hdr['login-customer-id'] = login
    body = json.dumps({'query': query}).encode()
    req = urllib.request.Request(f'https://googleads.googleapis.com/v20/customers/{cid}/googleAds:searchStream',
                                  data=body, method='POST', headers=hdr)
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        raw = json.load(r)
    rows = []
    if isinstance(raw, list):
        for b in raw:
            if 'results' in b: rows.extend(b['results'])
    elif 'results' in raw: rows = raw['results']
    return rows

GADS_ACCOUNTS = [
    {'id': '5145735707', 'name': 'Proper Inversiones - Landing', 'login': '8961854752'},
    {'id': '3949022627', 'name': 'Proper Rentas',                'login': None},
]
try:
    first_of_month = today.replace(day=1).isoformat()
    last_day = today.isoformat()
    for acc in GADS_ACCOUNTS:
        try:
            q_acc = (f"SELECT campaign.name, metrics.cost_micros "
                     f"FROM campaign WHERE segments.date BETWEEN '{first_of_month}' AND '{last_day}'")
            rows = _gads_query_account(acc['id'], q_acc, acc['login'])
            by_camp = {}
            for r in rows:
                c = r.get('campaign', {}).get('name', '—')
                cost = float(r.get('metrics', {}).get('costMicros', 0)) / 1_000_000.0
                by_camp[c] = by_camp.get(c, 0.0) + cost
            acc_total = sum(by_camp.values())
            google_mtd_total_pen += acc_total
            for c, v in by_camp.items():
                if v > 0:
                    google_campaigns_mtd.append({'name': c, 'spend': round(v, 2), 'account': acc['name'], 'account_id': acc['id']})
            print(f"   · {acc['name']}: S/ {acc_total:,.2f} ({len(by_camp)} campañas)")
        except Exception as e:
            print(f"   ✗ {acc['name']}: {e}")
    google_mtd_total_pen = round(google_mtd_total_pen, 2)
    google_campaigns_mtd.sort(key=lambda x: x['spend'], reverse=True)
    print(f"   ✓ TOTAL Google: S/ {google_mtd_total_pen:,.2f} ({len(google_campaigns_mtd)} campañas con gasto)")
except Exception as e:
    print(f"   ✗ falló: {e}")

# ============================================================
# 4c) WhatsApp WABA pricing_analytics (mes en curso) → costo MTD
# ============================================================
print("→ WhatsApp WABA pricing_analytics (mes en curso)...")
waba_breakdown = []
waba_all = []  # incluye los que tuvieron 0 gasto y 0 volumen
wa_cost_usd = 0.0
wa_cost_pen_native = 0.0
wa_volume = 0
try:
    wabas = []
    _url = f'https://graph.facebook.com/v19.0/{BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id,name,currency&limit=100&access_token={META_TOKEN}'
    while _url:
        _d = _g(_url)
        wabas.extend(_d.get('data', []))
        _url = (_d.get('paging') or {}).get('next')
    for w in wabas:
        wid = w['id']; cur = w.get('currency','USD'); name = w.get('name','?')
        try:
            r = _g(f'https://graph.facebook.com/v19.0/{wid}?fields=pricing_analytics.start({_month_start_ts}).end({_now_ts}).granularity(DAILY)&access_token={META_TOKEN}')
            buckets = r.get('pricing_analytics', {}).get('data', [])
            vol = sum(p.get('volume',0) or 0 for b in buckets for p in b.get('data_points', []))
            cost = sum(p.get('cost',0)   or 0 for b in buckets for p in b.get('data_points', []))
        except Exception:
            vol, cost = 0, 0
        wa_volume += vol
        if cur == 'PEN': wa_cost_pen_native += cost
        else:            wa_cost_usd += cost
        waba_all.append({'id': wid, 'name': name, 'currency': cur,
                         'volume': vol, 'cost': round(cost, 2)})
        if vol or cost:
            waba_breakdown.append({'id': wid, 'name': name, 'currency': cur,
                                   'volume': vol, 'cost': round(cost, 2)})
    print(f"   ✓ {len(wabas)} WABAs · vol={wa_volume} · USD={wa_cost_usd:.2f} · PEN={wa_cost_pen_native:.2f}")
except Exception as e:
    print(f"   ✗ WABA pricing falló: {e}")

whatsapp_mtd_pen = round(wa_cost_usd * USD_PEN_RATE + wa_cost_pen_native, 2)

# ============================================================
# Mapeo de cuenta → unidad de negocio
# Unidades: inversiones, rentas, modo, novo3, sin_clasificar
# ============================================================
# Override explícito por ID de cuenta Meta (cuando el nombre no es obvio)
META_ACCOUNT_UNIT_OVERRIDE = {
    'act_424971935894203': 'proper',         # Cuenta en soles Propinvest
    'act_945594697882747': 'novo3',          # Novo 3 - 2026
    'act_1902846807035847': 'novo3',         # Novo3
    'act_312666313151745': 'sin_clasificar', # Cuenta publicitaria de prueba en soles
    'act_2622251458057167': 'proper',        # Propinvest
}
# Override por ID de WABA
WABA_UNIT_OVERRIDE = {
    # (vacío; el mapeo por nombre alcanza). Agregar aquí si hace falta corrección manual.
}

def map_unit_by_name(name):
    n = (name or '').upper()
    if 'NOVO' in n: return 'novo3'
    return 'proper'

def unit_for_meta_account(acc):
    return META_ACCOUNT_UNIT_OVERRIDE.get(acc.get('id'), map_unit_by_name(acc.get('name')))

def unit_for_google_campaign(camp):
    return map_unit_by_name(camp.get('name'))

def unit_for_waba(w):
    return WABA_UNIT_OVERRIDE.get(w.get('id'), map_unit_by_name(w.get('name')))

# ============================================================
# Construir desglose por unidad (Inversiones / Rentas / MODO / Novo 3)
# ============================================================
UNITS = ['proper', 'novo3', 'sin_clasificar']
def _new_unit():
    return {
        'meta': 0.0, 'google': 0.0, 'tiktok': 0.0, 'whatsapp': 0.0, 'total': 0.0,
        'detail': {'meta': [], 'google': [], 'tiktok': [], 'whatsapp': []},
        'counts': {  # totales para el header "X con gasto, Y sin actividad"
            'meta_total': 0, 'meta_with_spend': 0,
            'google_total': 0,
            'tiktok_total': 0,
            'whatsapp_total': 0, 'whatsapp_with_activity': 0,
        },
    }
by_unit = {u: _new_unit() for u in UNITS}

# Meta — TODAS las cuentas activas (con o sin gasto) para contar correctamente
for a in meta_accounts_all:
    u = unit_for_meta_account(a)
    by_unit[u]['counts']['meta_total'] += 1
    if a['spend'] > 0:
        by_unit[u]['counts']['meta_with_spend'] += 1
        by_unit[u]['meta'] += a['spend_pen']
        by_unit[u]['detail']['meta'].append({
            'id': a['id'], 'name': a['name'], 'currency': a['currency'],
            'spend': a['spend'], 'spend_pen': a['spend_pen'],
        })

# Google — campaña por campaña (asumimos PEN nativo del customer 5145735707)
for c in google_campaigns_mtd:
    u = unit_for_google_campaign(c)
    by_unit[u]['counts']['google_total'] += 1
    by_unit[u]['google'] += c['spend']
    by_unit[u]['detail']['google'].append({
        'name': c['name'], 'spend': c['spend'], 'spend_pen': c['spend'],
    })

# WhatsApp — TODAS las WABAs (incluso sin gasto) para contar
for w in waba_all:
    u = unit_for_waba(w)
    by_unit[u]['counts']['whatsapp_total'] += 1
    if w['cost'] > 0 or w['volume'] > 0:
        by_unit[u]['counts']['whatsapp_with_activity'] += 1
    cost_pen = w['cost'] * USD_PEN_RATE if w.get('currency') != 'PEN' else w['cost']
    by_unit[u]['whatsapp'] += cost_pen
    if w['cost'] > 0 or w['volume'] > 0:
        by_unit[u]['detail']['whatsapp'].append({
            'id': w['id'], 'name': w['name'], 'currency': w['currency'],
            'cost': w['cost'], 'cost_pen': round(cost_pen, 2), 'volume': w['volume'],
        })
# Ordenar WABAs por costo descendente dentro de cada unidad
for u in UNITS:
    by_unit[u]['detail']['whatsapp'].sort(key=lambda x: x['cost_pen'], reverse=True)

# TikTok — todavía no integrado; placeholder vacío
# (cuando se integre, iterar por cuenta y asignar unidad)

# Totales por unidad + redondeo
for u in UNITS:
    by_unit[u]['meta']     = round(by_unit[u]['meta'], 2)
    by_unit[u]['google']   = round(by_unit[u]['google'], 2)
    by_unit[u]['tiktok']   = round(by_unit[u]['tiktok'], 2)
    by_unit[u]['whatsapp'] = round(by_unit[u]['whatsapp'], 2)
    by_unit[u]['total']    = round(by_unit[u]['meta'] + by_unit[u]['google'] + by_unit[u]['tiktok'] + by_unit[u]['whatsapp'], 2)

# ============================================================
# Construir bloque budget_monthly con 4 canales separados
# ============================================================
def _channel(name, mtd, budget, accounts):
    rrd = round(mtd / max(days_elapsed, 1), 2)
    return {
        'name': name,
        'budget': budget,
        'mtd': round(mtd, 2),
        'pct_used': round(mtd / budget * 100, 1) if budget else 0,
        'run_rate_daily': rrd,
        'projected_eom': round(rrd * days_in_month, 2),
        'accounts': accounts,
    }

# TikTok: pendiente de integración API (deja MTD=0, accounts=[])
tiktok_mtd = 0.0
tiktok_accounts = []

# Budgets de PROPER por canal (Novo 3 va aparte con BUDGET_NOVO3_TOTAL)
_proper_budgets = {
    'meta': BUDGET_META_PEN, 'google': BUDGET_GOOGLE_PEN,
    'tiktok': BUDGET_TIKTOK_PEN, 'whatsapp': BUDGET_WHATSAPP_PEN,
}
_total_budget = sum(_proper_budgets.values()) + BUDGET_NOVO3_TOTAL
_total_mtd    = meta_mtd_total_pen + google_mtd_total_pen + tiktok_mtd + whatsapp_mtd_pen

# Bloques separados Proper vs Novo 3
proper_u = by_unit.get('proper', _new_unit())
novo3_u  = by_unit.get('novo3',  _new_unit())

def _channel_proper(canal_key, label, budget):
    mtd = proper_u.get(canal_key, 0.0)
    return _channel(label, mtd, budget, proper_u['detail'].get(canal_key, []))

novo3_total = novo3_u['total']
novo3_pct = round(novo3_total / BUDGET_NOVO3_TOTAL * 100, 1) if BUDGET_NOVO3_TOTAL else 0
novo3_rrd = round(novo3_total / max(days_elapsed, 1), 2)

_budget_block = {
    'currency': 'PEN',
    'usd_pen_rate': USD_PEN_RATE,
    'month_start': month_start_str,
    'days_in_month': days_in_month,
    'days_elapsed': days_elapsed,
    'total_budget': _total_budget,
    'total_mtd': round(_total_mtd, 2),
    'total_pct_used': round(_total_mtd / _total_budget * 100, 1) if _total_budget else 0,

    # PROPER — canales con su budget y detalle de cuentas
    'proper': {
        'budget_total': sum(_proper_budgets.values()),
        'mtd_total': round(proper_u['total'], 2),
        'pct_used': round(proper_u['total'] / sum(_proper_budgets.values()) * 100, 1),
        'channels': {
            'meta':     _channel_proper('meta',     'Meta Ads',     BUDGET_META_PEN),
            'google':   _channel_proper('google',   'Google Ads',   BUDGET_GOOGLE_PEN),
            'tiktok':   _channel_proper('tiktok',   'TikTok Ads',   BUDGET_TIKTOK_PEN),
            'whatsapp': _channel_proper('whatsapp', 'WhatsApp API', BUDGET_WHATSAPP_PEN),
        },
        'counts': proper_u['counts'],
    },

    # NOVO 3 — budget total único entre todos los canales
    'novo3': {
        'budget_total': BUDGET_NOVO3_TOTAL,
        'mtd_total': round(novo3_total, 2),
        'pct_used': novo3_pct,
        'run_rate_daily': novo3_rrd,
        'projected_eom': round(novo3_rrd * days_in_month, 2),
        'channels': {
            'meta':     novo3_u['meta'],
            'google':   novo3_u['google'],
            'tiktok':   novo3_u['tiktok'],
            'whatsapp': novo3_u['whatsapp'],
        },
        'detail': novo3_u['detail'],
        'counts': novo3_u['counts'],
    },

    # Compat anterior (canales globales agregando Proper + Novo3)
    'channels': {
        'meta':     _channel('Meta Ads',     meta_mtd_total_pen,   BUDGET_META_PEN,     meta_accounts_mtd),
        'google':   _channel('Google Ads',   google_mtd_total_pen, BUDGET_GOOGLE_PEN,   google_campaigns_mtd),
        'tiktok':   _channel('TikTok Ads',   tiktok_mtd,           BUDGET_TIKTOK_PEN,   tiktok_accounts),
        'whatsapp': _channel('WhatsApp API', whatsapp_mtd_pen,     BUDGET_WHATSAPP_PEN, waba_breakdown),
    },
    # Compat con el filtro LANDING existente (solo campañas LANDING)
    'landing_only': {
        'meta_mtd': meta_mtd,
        'gads_mtd': gads_mtd,
        'total_mtd': total_mtd,
    },
    'whatsapp_volume_mtd': wa_volume,
    'by_unit': by_unit,
    'unit_labels': {
        'proper':          'Proper',
        'novo3':           'Novo 3',
        'sin_clasificar':  'Sin clasificar',
    },
}

# ============================================================
# Budget BY PRODUCT (Inversiones vs Rentas) — desglose pedido por el negocio
# Inversiones: campañas Meta con "LANDING" + Google customer 5145735707
# Rentas     : campañas Meta con "RENTA"   + Google customer 3949022627
# ============================================================
print("→ Calculando budget by product (Inversiones + Rentas)...")

# Meta mes en curso — UNA query, classify por ID (con fallback a nombre)
print("   · Meta MTD (classify por ID de campaña: Inv/Ren/Modo/Otro)...")
try:
    _url_meta_mtd = ("https://graph.facebook.com/v19.0/act_424971935894203/insights"
                     "?fields=spend,impressions,clicks,campaign_id,campaign_name"
                     "&level=campaign&time_range=" + urllib.parse.quote(json.dumps({"since": month_start_str, "until": until}))
                     + "&limit=500&access_token=" + META_TOKEN)
    _meta_mtd_rows = _meta_paged(_url_meta_mtd)
    _bucket = {'inv': [], 'ren': [], 'modo': [], 'otro': []}
    for r in _meta_mtd_rows:
        cat = classify_campaign(r.get('campaign_id'), r.get('campaign_name', ''))
        _bucket[cat].append(r)
    # Inversiones (todas las campañas Inv, no solo LANDING)
    meta_inversiones_mtd_full = round(sum(float(r.get('spend', 0)) for r in _bucket['inv']), 2)
    meta_inversiones_campaigns_full = [
        {'name': r.get('campaign_name',''), 'spend': round(float(r.get('spend',0)), 2)}
        for r in _bucket['inv']
    ]
    # Rentas
    meta_rentas_mtd = round(sum(float(r.get('spend', 0)) for r in _bucket['ren']), 2)
    meta_rentas_campaigns = [
        {'name': r.get('campaign_name',''), 'spend': round(float(r.get('spend',0)), 2)}
        for r in _bucket['ren']
    ]
    # MODO y Otro (informativo, NO se cuentan en el budget Inv+Ren)
    meta_modo_mtd = round(sum(float(r.get('spend', 0)) for r in _bucket['modo']), 2)
    meta_otro_mtd = round(sum(float(r.get('spend', 0)) for r in _bucket['otro']), 2)
    print(f"     Inv {len(_bucket['inv']):>2} camps · S/ {meta_inversiones_mtd_full:>9,.2f}")
    print(f"     Ren {len(_bucket['ren']):>2} camps · S/ {meta_rentas_mtd:>9,.2f}")
    print(f"     [excluidos] MODO S/ {meta_modo_mtd:,.2f} · Otro S/ {meta_otro_mtd:,.2f}")
except Exception as e:
    print(f"     ✗ falló: {e}")
    meta_inversiones_mtd_full, meta_inversiones_campaigns_full = 0.0, []
    meta_rentas_mtd, meta_rentas_campaigns = 0.0, []
    meta_modo_mtd, meta_otro_mtd = 0.0, 0.0

# Google Rentas — customer 3949022627 (acceso directo, sin manager)
print("   · Google Rentas (customer 3949022627)...")
try:
    _gads_rentas_rows = _gads_query_account(
        '3949022627',
        f"SELECT campaign.name, metrics.cost_micros "
        f"FROM campaign WHERE segments.date BETWEEN '{month_start_str}' AND '{until}'",
        login=None
    )
    gads_rentas_campaigns = []
    gads_rentas_mtd = 0.0
    for r in _gads_rentas_rows:
        cname = r.get('campaign', {}).get('name', '—')
        cost = float(r.get('metrics', {}).get('costMicros', 0)) / 1_000_000.0
        if cost > 0:
            gads_rentas_campaigns.append({'name': cname, 'spend': round(cost, 2)})
        gads_rentas_mtd += cost
    gads_rentas_mtd = round(gads_rentas_mtd, 2)
    print(f"     ✓ {len(gads_rentas_campaigns)} campañas Rentas · S/ {gads_rentas_mtd:,.2f} MTD")
except Exception as e:
    print(f"     ✗ falló: {e}")
    gads_rentas_mtd, gads_rentas_campaigns = 0.0, []

# Inversiones: usamos el classifier (TODAS las campañas Inv, no solo LANDING).
# Antes era meta_mtd (filtro LANDING), ahora usamos meta_inversiones_mtd_full del classifier.
meta_inversiones_mtd = meta_inversiones_mtd_full
gads_inversiones_mtd = gads_mtd  # Google customer 5145735707 (filtro LANDING en query; OK porque solo hay 1 campaña)
meta_inversiones_campaigns = sorted(meta_inversiones_campaigns_full, key=lambda x: -x['spend'])
gads_inversiones_campaigns_agg = {}
for r in gads_campaigns:
    if r['fecha'] < month_start_str: continue
    gads_inversiones_campaigns_agg[r['campaign']] = gads_inversiones_campaigns_agg.get(r['campaign'], 0) + r['spend']
gads_inversiones_campaigns = sorted(
    [{'name': k, 'spend': round(v, 2)} for k, v in gads_inversiones_campaigns_agg.items()],
    key=lambda x: -x['spend']
)

# Budgets por producto (PEN). Modificable.
BUDGET_PRODUCTS = {
    'inversiones': {
        'label': 'Proper Inversiones',
        'channels': {
            'facebook': {'budget': 6000.0, 'note': 'Campañas con "LANDING" en act_424971935894203'},
            'google':   {'budget': 1900.0, 'note': 'Customer 5145735707'},
        }
    },
    'rentas': {
        'label': 'Proper Rentas',
        'channels': {
            'facebook': {'budget': 900.0,  'note': 'Campañas con "RENTA" en act_424971935894203'},
            'google':   {'budget': 500.0,  'note': 'Customer 3949022627 — Experimento (reasignado de Inversiones)'},
        }
    }
}

def _ch(prod, ch, mtd, campaigns):
    cfg = BUDGET_PRODUCTS[prod]['channels'][ch]
    b = cfg['budget']
    pct = round(mtd/b*100, 1) if b else 0
    rrd = round(mtd / max(days_elapsed, 1), 2)
    return {
        'budget': b,
        'mtd': round(mtd, 2),
        'pct_used': pct,
        'run_rate_daily': rrd,
        'projected_eom': round(rrd * days_in_month, 2),
        'note': cfg.get('note',''),
        'campaigns': campaigns,
    }

def _product(prod, fb_mtd, gads_mtd_p, fb_camps, gads_camps):
    fb = _ch(prod, 'facebook', fb_mtd, fb_camps)
    gd = _ch(prod, 'google',   gads_mtd_p, gads_camps)
    tot_budget = fb['budget'] + gd['budget']
    tot_mtd    = fb['mtd']    + gd['mtd']
    pct = round(tot_mtd / tot_budget * 100, 1) if tot_budget else 0
    rrd = round(tot_mtd / max(days_elapsed, 1), 2)
    return {
        'label':   BUDGET_PRODUCTS[prod]['label'],
        'budget':  round(tot_budget, 2),
        'mtd':     round(tot_mtd, 2),
        'pct_used': pct,
        'run_rate_daily': rrd,
        'projected_eom': round(rrd * days_in_month, 2),
        'channels': {'facebook': fb, 'google': gd},
    }

_inv = _product('inversiones', meta_inversiones_mtd, gads_inversiones_mtd, meta_inversiones_campaigns, gads_inversiones_campaigns)
_rnt = _product('rentas',      meta_rentas_mtd,      gads_rentas_mtd,      meta_rentas_campaigns,      gads_rentas_campaigns)
_total_budget_by_product = _inv['budget'] + _rnt['budget']
_total_mtd_by_product    = _inv['mtd']    + _rnt['mtd']
_total_rrd               = round(_total_mtd_by_product / max(days_elapsed, 1), 2)

budget_by_product = {
    'month_start': month_start_str,
    'currency': 'PEN',
    'days_in_month': days_in_month,
    'days_elapsed': days_elapsed,
    'pct_month_elapsed': round(days_elapsed / days_in_month * 100, 1),
    'total': {
        'budget': round(_total_budget_by_product, 2),
        'mtd':    round(_total_mtd_by_product, 2),
        'pct_used': round(_total_mtd_by_product / _total_budget_by_product * 100, 1) if _total_budget_by_product else 0,
        'run_rate_daily': _total_rrd,
        'projected_eom': round(_total_rrd * days_in_month, 2),
        'remaining_budget': round(_total_budget_by_product - _total_mtd_by_product, 2),
    },
    'products': {
        'inversiones': _inv,
        'rentas':      _rnt,
    },
}
print(f"   ✓ Inversiones MTD: S/ {_inv['mtd']:,.2f} / S/ {_inv['budget']:,.2f} ({_inv['pct_used']}%)")
print(f"   ✓ Rentas      MTD: S/ {_rnt['mtd']:,.2f} / S/ {_rnt['budget']:,.2f} ({_rnt['pct_used']}%)")

# ============================================================
# Histórico: spend por canal/producto en los últimos 6 meses
# ============================================================
print("→ Histórico spend (últimos 6 meses)...")
import calendar as _cal

def _yyyy_mm(y, m):
    return f"{y}-{m:02d}"

historical_months = []
MONTH_LABELS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']
for i in range(5, -1, -1):
    y = today.year
    m = today.month - i
    while m <= 0:
        m += 12; y -= 1
    days_im = _cal.monthrange(y, m)[1]
    m_start = f"{y}-{m:02d}-01"
    is_current = (y == today.year and m == today.month)
    m_end = today.isoformat() if is_current else f"{y}-{m:02d}-{days_im:02d}"
    days_elapsed_local = today.day if is_current else days_im
    label = f"{MONTH_LABELS[m-1]} {y}" + (f" (d{today.day})" if is_current else "")
    print(f"   · {label}: {m_start} → {m_end}")

    # Meta — UNA query por mes, classify por ID con fallback a nombre
    meta_inv = 0.0; meta_ren = 0.0; meta_modo = 0.0; meta_otro = 0.0
    try:
        _url = ("https://graph.facebook.com/v19.0/act_424971935894203/insights"
                "?fields=spend,campaign_id,campaign_name&level=campaign"
                "&time_range=" + urllib.parse.quote(json.dumps({'since': m_start, 'until': m_end}))
                + "&limit=500&access_token=" + META_TOKEN)
        rows = _meta_paged(_url)
        for r in rows:
            cat = classify_campaign(r.get('campaign_id'), r.get('campaign_name', ''))
            s = float(r.get('spend', 0) or 0)
            if   cat == 'inv':  meta_inv  += s
            elif cat == 'ren':  meta_ren  += s
            elif cat == 'modo': meta_modo += s
            else:               meta_otro += s
    except Exception as e:
        print(f"     Meta {label} falló: {e}")

    # Google Inversiones (5145735707)
    gads_inv = 0.0
    try:
        rs = _gads_query_account('5145735707',
            f"SELECT campaign.name, metrics.cost_micros FROM campaign "
            f"WHERE segments.date BETWEEN '{m_start}' AND '{m_end}' AND campaign.name LIKE '%LANDING%'",
            login='8961854752')
        gads_inv = sum(float((r.get('metrics') or {}).get('costMicros', 0)) / 1_000_000.0 for r in rs)
    except Exception as e:
        print(f"     GAds Inv {label} falló: {e}")

    # Google Rentas (3949022627)
    gads_ren = 0.0
    try:
        rs = _gads_query_account('3949022627',
            f"SELECT campaign.name, metrics.cost_micros FROM campaign "
            f"WHERE segments.date BETWEEN '{m_start}' AND '{m_end}'",
            login=None)
        gads_ren = sum(float((r.get('metrics') or {}).get('costMicros', 0)) / 1_000_000.0 for r in rs)
    except Exception as e:
        print(f"     GAds Ren {label} falló: {e}")

    meta_inv = round(meta_inv, 2); meta_ren = round(meta_ren, 2)
    meta_modo = round(meta_modo, 2); meta_otro = round(meta_otro, 2)
    gads_inv = round(gads_inv, 2); gads_ren = round(gads_ren, 2)
    inv_total = round(meta_inv + gads_inv, 2)
    ren_total = round(meta_ren + gads_ren, 2)
    total_spend = round(inv_total + ren_total, 2)  # SOLO Inv + Ren cuentan (MODO/Otro excluidos del budget)
    excluded_total = round(meta_modo + meta_otro, 2)  # informativo: spend que NO cuenta

    historical_months.append({
        'month': _yyyy_mm(y, m),
        'label': label,
        'days_in_month': days_im,
        'days_counted': days_elapsed_local,
        'is_current': is_current,
        'is_partial': is_current,
        'inversiones': {'facebook': meta_inv, 'google': gads_inv, 'total': inv_total},
        'rentas':      {'facebook': meta_ren, 'google': gads_ren, 'total': ren_total},
        'total_spend': total_spend,
        # Excluidos del budget Inv+Ren, pero útiles para entender dónde más se gastó
        'excluded': {'modo': meta_modo, 'otro': meta_otro, 'total': excluded_total},
        'budget_referencial': _total_budget_by_product,
        'pct_vs_budget': round(total_spend / _total_budget_by_product * 100, 1) if _total_budget_by_product else 0,
    })
    print(f"     Inv={inv_total} (FB {meta_inv} + GAds {gads_inv}) · Ren={ren_total} (FB {meta_ren} + GAds {gads_ren}) · Tot={total_spend} · [excl: MODO {meta_modo} Otro {meta_otro}]")

print(f"   ✓ {len(historical_months)} meses cargados")

output = {
    'generated_at': datetime.now(timezone.utc).isoformat(),
    'since': since, 'until': until,
    'source': 'bitrix.hs_deals (utm_campaign LIKE %landing%) + Meta Ads API + Google Ads API',
    'budget_monthly': _budget_block,
    'budget_by_product': budget_by_product,      # NEW: split Inversiones vs Rentas (Meta + Google)
    'historical_months': historical_months,      # NEW: spend últimos 6 meses por producto/canal
    'days': series,
    'meta_ads': meta_ads,                       # Meta: spend/impr/clicks por ad
    'gads_campaigns': gads_campaigns,            # Google: spend/impr/clicks por campaign
    'gads_asset_groups': gads_asset_groups,
    'postgres_campaigns': postgres_campaigns,    # Bitrix: leads/aprobados por utm_campaign+medium+term
}
out_file = HERE / 'data.json'
# Fuente de verdad del dashboard: snapshot en Postgres. data.json solo para debug.
snap_id = None
if os.environ.get('DATABASE_URL'):
    snap_id = db.save_snapshot(output, kind='budget')
    print(f"\n✅ snapshot #{snap_id} guardado en Postgres (kind=budget)")
else:
    print("\n⚠ DATABASE_URL no seteada → no se guardó snapshot en Postgres")
if WRITE_DATA_JSON or not snap_id:
    out_file.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"   data.json escrito (debug): {out_file}")

# Totals
def s(k): return sum(x[k] or 0 for x in series)
print(f"\n✅ {out_file}")
print(f"   {len(series)} días · {len(meta_ads)} meta_ads · {len(gads_campaigns)} gads · {len(postgres_campaigns)} pg_campaigns")
print(f"   Spend total 60d: S/{s('total_spend'):,.2f}  (Meta S/{s('meta_spend'):,.2f} + Google S/{s('gads_spend'):,.2f})")
print(f"   Leads 60d: {s('leads'):,}  ·  Aprobados: {s('aprobados'):,}  ·  No aprobados: {s('no_aprobados'):,}")
print(f"   Categoría: Alto={s('alto')} Medio={s('medio')} Empuje={s('empuje')} Aprob.Int={s('aprobado_int')}")
print(f"              NoAprob.Nac={s('no_aprobado_nac')} NoAprob.Int={s('no_aprobado_int')} SinClasif={s('sin_clasificar')}")
