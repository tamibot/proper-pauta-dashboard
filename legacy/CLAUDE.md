# CLAUDE.md — proper-pauta-dashboard (público)

> Este es el repo **público** que sirve el dashboard en GitHub Pages.
> Es solo el frontend (`index.html` + `app.js` + `data.json`).
>
> **La fuente de verdad y toda la lógica de generación vive en el repo privado `tamibot/proper-ia`** —
> específicamente en `dashboards/inversion-pauta/`. Si trabajás con este repo, **leé primero ese
> CLAUDE.md detallado** para entender el cableado completo.

## Quick start

- **Live:** https://tamibot.github.io/proper-pauta-dashboard/
- **Stack:** HTML estático + Tailwind CDN + Chart.js CDN + Flatpickr CDN — sin build step
- **`data.json`** se regenera offline desde el repo privado (`build-data.py`).
  Acá solo se commitea el JSON ya generado.

## Cómo trabajar acá

### Si vas a tocar SOLO frontend (HTML/CSS/JS):
1. Editás `index.html` o `app.js`
2. Si tocás JS, bumpea el cache-buster en `index.html`:
   ```html
   <script src="./app.js?v=12"></script>   <!-- subir de 11 a 12, etc -->
   ```
3. Test local:
   ```bash
   python3 -m http.server 8080
   # abrir http://localhost:8080
   ```
4. Commit + push a `main` → GitHub Pages redeploya en ~30-60s

### Si necesitás regenerar `data.json` (datos frescos):
Ese trabajo se hace desde el repo privado:
```bash
cd /path/to/proper-ia/dashboards/inversion-pauta
./refresh.sh
# El script regenera data.json, lo copia acá, hace commit y push
```

## Estructura

```
.
├── index.html      # Estructura DOM (2 vistas: Presupuesto + Dashboard)
├── app.js          # Vanilla JS — render + simulador + chart.js
├── data.json       # ~250KB. Generado offline. NO editarlo a mano.
├── README.md       # Doc de usuario final
└── CLAUDE.md       # Este archivo
```

## Las 2 vistas

| Vista | Qué muestra |
|---|---|
| 💰 **Presupuesto** | Tope mensual S/9,300 con split Inversiones (S/7,900) / Rentas (S/1,400), simulador editable, histórico 6 meses |
| 📊 **Dashboard** | Embudo de conversión, charts leads/CPL/canales, detalle Meta/Google, tabla diaria |

## Convenciones críticas

- **NO hardcodear datos** — todo viene de `data.json`
- **NO hacer llamadas a APIs** desde el frontend (CORS + token leakage)
- **Tope estricto S/9,300** en el simulador — si total ≠ 9300, botón Guardar bloqueado
- **MODO y ARISE NO se incluyen** en el budget Inv+Ren (tienen su propio budget separado)
- **Los IDs HTML importantes** del Presupuesto están todos en `index.html` con prefijos claros:
  `kpi-*`, `inv-*`, `rnt-*`, `sim-*`, `hist-*`, `actual-*`, `comp-*`

## ⚠️ Lo que NO está en este repo (pero podrías necesitar)

- **Credenciales** Meta/Google/Postgres → en `tamibot/proper-ia/credenciales/` (privado)
- **`build-data.py`** (el ETL que genera data.json) → en `tamibot/proper-ia/dashboards/inversion-pauta/`
- **`CAMPAIGN_ID_TO_CATEGORY`** (el classifier de campañas Meta) → en `build-data.py`
- **`refresh.sh`** (orquestador de regen + push) → en `tamibot/proper-ia/dashboards/inversion-pauta/`

Si necesitás cambiar cómo se calculan los datos (no cómo se ven), tenés que ir al repo privado.

## Cambios recientes (changelog corto)

### 2026-05-26
- v11: histórico 6 meses + classifier por ID de campaña
- v10: vistas separadas Presupuesto/Dashboard + Simulador editable
- v9: sección Budget Mes en Curso (Inv + Ren, Meta + Google)
- v8: fix TZ bug en range picker

## Owner

- `tamibot / nezarethpatino77`
- nezareth.la.10@gmail.com
- Proper Inversiones (Lima, Perú)
