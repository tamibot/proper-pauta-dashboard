// ============================================================================
// Dashboard de Inversión en Pauta — vanilla JS + Chart.js
// ============================================================================
const COLORS = {
  meta:    '#1877f2',
  google:  '#fbbc04',
  apr:     '#10b981',  // aprobados — verde
  noApr:   '#ef4444',  // no aprobados — rojo
  cpl:     '#2563eb',  // azul intenso
  cplAp:   '#f97316',  // naranja — contrasta bien con azul
  facebook: '#1877f2',
  instagram:'#e1306c',
  google_c: '#fbbc04',
  an:       '#34d399',
  otros:    '#9ca3af',
};

let DATA = null;
let CURRENT_RANGE = 30;
let CUSTOM_FROM = null;
let CUSTOM_TO   = null;
let VIEW_MODE   = 'daily';  // 'daily' | 'weekly'
let SORT_COL = 'fecha';
let SORT_DIR = -1;  // desc

const fmt_s   = v => 'S/' + (Number(v||0)).toLocaleString('es-PE', {minimumFractionDigits:2, maximumFractionDigits:2});
const fmt_n   = v => (Number(v||0)).toLocaleString('es-PE');
const fmt_pct = v => v == null ? '—' : (v*100).toFixed(1) + '%';
const fmt_d   = d => { const [y,m,dd] = d.split('-'); return `${dd}/${m}`; };
const fmt_d_full = d => new Date(d+'T00:00').toLocaleDateString('es-PE', {weekday:'short', day:'2-digit', month:'short'});

// Label de eje X según el modo de vista
function fmt_x_label(row){
  if (VIEW_MODE === 'weekly') {
    // row.fecha es lunes; mostrar "Sem DD/MM"
    return 'Sem ' + fmt_d(row.fecha);
  }
  return fmt_d(row.fecha);
}
// Label completo para tooltips/tablas
function fmt_d_view(fechaStr){
  if (VIEW_MODE === 'weekly') {
    // fechaStr es lunes; mostrar "Semana del DD/MM/YY – DD/MM/YY"
    const d = new Date(fechaStr + 'T12:00:00');
    const end = new Date(d); end.setDate(d.getDate()+6);
    const ff = (x) => `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}`;
    return `Semana del ${ff(d)} – ${ff(end)}`;
  }
  return fmt_d_full(fechaStr);
}

function pickRange(days, rangeKey){
  if (rangeKey === 'mtd') {
    const today = new Date();
    const first = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-01';
    return days.filter(d => d.fecha >= first);
  }
  if (rangeKey === 'custom') {
    if (!CUSTOM_FROM || !CUSTOM_TO) return days.slice(-30);
    return days.filter(d => d.fecha >= CUSTOM_FROM && d.fecha <= CUSTOM_TO);
  }
  const n = parseInt(rangeKey, 10);
  // últimos N días con datos
  return days.slice(-n);
}

// =============================================================
// Agregación por semana (Lun-Dom). Devuelve "días sintéticos"
// donde fecha = lunes de cada semana, con todas las métricas sumadas.
// =============================================================
function aggregateByWeek(days){
  const groups = {};
  const SUM_FIELDS = [
    'meta_spend','gads_spend','total_spend',
    'meta_impressions','meta_clicks','gads_impressions','gads_clicks',
    'leads','aprobados','no_aprobados',
    'alto','medio','empuje','aprobado_int',
    'no_aprobado_nac','no_aprobado_int','sin_clasificar',
    'altos_medios','asistentes','simulados','cotizados',
  ];
  const SUM_CANAL_FIELDS = [
    'leads','aprobados','alto','medio','empuje','aprobado_int',
    'no_aprobado_nac','no_aprobado_int','sin_clasificar',
    'asistentes','simulados','cotizados'
  ];

  days.forEach(d => {
    const wk = weekKey(d.fecha);
    if (!groups[wk]) {
      groups[wk] = { fecha: wk, canales: {}, days_count: 0 };
      SUM_FIELDS.forEach(f => groups[wk][f] = 0);
    }
    const g = groups[wk];
    g.days_count++;
    SUM_FIELDS.forEach(f => g[f] += (Number(d[f]) || 0));
    Object.entries(d.canales || {}).forEach(([canal, info]) => {
      if (!g.canales[canal]) {
        g.canales[canal] = {};
        SUM_CANAL_FIELDS.forEach(f => g.canales[canal][f] = 0);
      }
      SUM_CANAL_FIELDS.forEach(f => g.canales[canal][f] += (Number(info[f]) || 0));
    });
  });

  // Recompute CPLs
  Object.values(groups).forEach(g => {
    g.cpl          = g.leads     > 0 ? Math.round((g.total_spend / g.leads)     * 100) / 100 : null;
    g.cpl_aprobado = g.aprobados > 0 ? Math.round((g.total_spend / g.aprobados) * 100) / 100 : null;
  });

  return Object.values(groups).sort((a,b) => a.fecha < b.fecha ? -1 : 1);
}

// Obtener rows transformadas según VIEW_MODE
function getViewRows(){
  let rows = pickRange(DATA.days, CURRENT_RANGE);
  if (VIEW_MODE === 'weekly') rows = aggregateByWeek(rows);
  return rows;
}

const CHARTS = {};

function destroyChart(id){
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
}

function renderKPIs(rows){
  const sum = (k) => rows.reduce((a,r) => a + (Number(r[k])||0), 0);
  const totSpend = sum('total_spend');
  const totMeta  = sum('meta_spend');
  const totGads  = sum('gads_spend');
  const totLeads = sum('leads');
  const totApr   = sum('aprobados');
  const cpl     = totLeads > 0 ? totSpend/totLeads : null;
  const cplAp   = totApr   > 0 ? totSpend/totApr   : null;
  const tasaApr = totLeads > 0 ? totApr / totLeads : null;
  const promLeads = rows.length > 0 ? totLeads / rows.length : 0;

  document.getElementById('kpi-spend').textContent = fmt_s(totSpend);
  document.getElementById('kpi-spend-split').textContent = `Meta ${fmt_s(totMeta)} · Google ${fmt_s(totGads)}`;
  document.getElementById('kpi-leads').textContent = fmt_n(totLeads);
  document.getElementById('kpi-leads-avg').textContent = `prom ${promLeads.toFixed(1)} / día`;
  document.getElementById('kpi-aprobados').textContent = fmt_n(totApr);
  document.getElementById('kpi-tasa-apr').textContent  = `${fmt_pct(tasaApr)} de aprobación`;
  document.getElementById('kpi-cpl').textContent       = cpl   ? fmt_s(cpl)   : '—';
  document.getElementById('kpi-cpl-ap').textContent    = cplAp ? fmt_s(cplAp) : '—';
}

function commonChartOpts(){
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(17,24,39,0.95)',
        padding: 10, cornerRadius: 8, titleFont:{size:12}, bodyFont:{size:12}
      }
    },
    scales: {
      x: { grid: { display: false }, ticks: { color:'#6b7280', font:{size:11}, maxRotation:0, autoSkipPadding:14 } },
      y: { grid: { color:'#f3f4f6' }, ticks: { color:'#6b7280', font:{size:11} } }
    }
  };
}

function chartSpend(rows){
  destroyChart('spend');
  const ctx = document.getElementById('chart-spend');
  CHARTS.spend = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => fmt_x_label(r)),
      datasets: [
        { label:'Meta',   data: rows.map(r=>r.meta_spend), backgroundColor: COLORS.meta,   borderRadius:4 },
        { label:'Google', data: rows.map(r=>r.gads_spend), backgroundColor: COLORS.google, borderRadius:4 }
      ]
    },
    options: {
      ...commonChartOpts(),
      plugins: {
        ...commonChartOpts().plugins,
        tooltip: {
          ...commonChartOpts().plugins.tooltip,
          callbacks: {
            title: (items) => fmt_d_view(rows[items[0].dataIndex].fecha),
            label: (c) => `${c.dataset.label}: ${fmt_s(c.parsed.y)}`,
            footer: (items) => {
              const r = rows[items[0].dataIndex];
              return `Total: ${fmt_s(r.total_spend)}`;
            }
          }
        }
      },
      scales: { ...commonChartOpts().scales, x:{...commonChartOpts().scales.x, stacked:true}, y:{...commonChartOpts().scales.y, stacked:true} }
    }
  });
}

function chartLeads(rows){
  destroyChart('leads');
  const ctx = document.getElementById('chart-leads');
  CHARTS.leads = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => fmt_x_label(r)),
      datasets: [
        { label:'Aprobados',     data: rows.map(r=>r.aprobados),    backgroundColor: COLORS.apr,   borderRadius: 4, stack:'leads' },
        { label:'No Aprobados',  data: rows.map(r=>r.no_aprobados), backgroundColor: COLORS.noApr, borderRadius: 4, stack:'leads' }
      ]
    },
    options: {
      ...commonChartOpts(),
      plugins: {
        ...commonChartOpts().plugins,
        tooltip: {
          ...commonChartOpts().plugins.tooltip,
          callbacks: {
            title: (items) => fmt_d_view(rows[items[0].dataIndex].fecha),
            label: (c) => `${c.dataset.label}: ${fmt_n(c.parsed.y)}`,
            footer: (items) => {
              const r = rows[items[0].dataIndex];
              return `Total Leads: ${fmt_n(r.leads)}`;
            }
          }
        }
      },
      scales: {
        ...commonChartOpts().scales,
        x:{...commonChartOpts().scales.x, stacked:true},
        y:{...commonChartOpts().scales.y, stacked:true}
      }
    }
  });
}

function chartCPL(rows){
  destroyChart('cpl');
  const ctx = document.getElementById('chart-cpl');
  CHARTS.cpl = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmt_x_label(r)),
      datasets: [
        { label:'CPL',          data: rows.map(r=>r.cpl),          borderColor: COLORS.cpl,   tension:.3, pointRadius:3, borderWidth:2, spanGaps:true },
        { label:'CPL Aprobado', data: rows.map(r=>r.cpl_aprobado), borderColor: COLORS.cplAp, tension:.3, pointRadius:3, borderWidth:2, spanGaps:true }
      ]
    },
    options: {
      ...commonChartOpts(),
      plugins: { ...commonChartOpts().plugins, tooltip: { ...commonChartOpts().plugins.tooltip,
        callbacks: {
          title: (items) => fmt_d_view(rows[items[0].dataIndex].fecha),
          label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '—' : fmt_s(c.parsed.y)}`
        }
      }}
    }
  });
}

function chartCanales(rows){
  destroyChart('canales');
  // Sumar leads por canal en el rango (data.canales viene de hs_deals.utm_source)
  const totalsByCanal = {};
  rows.forEach(r => {
    Object.entries(r.canales || {}).forEach(([c, info]) => {
      if (!totalsByCanal[c]) totalsByCanal[c] = 0;
      totalsByCanal[c] += (info.leads || 0);
    });
  });
  const labels = Object.keys(totalsByCanal);
  const values = Object.values(totalsByCanal);
  const colorMap = { 'Facebook': COLORS.facebook, 'Instagram': COLORS.instagram, 'Google': COLORS.google_c, 'Audience Network': COLORS.an };
  const colors = labels.map(l => colorMap[l] || COLORS.otros);

  const ctx = document.getElementById('chart-canales');
  CHARTS.canales = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { font:{size:11}, color:'#374151', padding:12, usePointStyle:true } },
        tooltip: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          callbacks: {
            label: (c) => {
              const tot = values.reduce((a,b)=>a+b,0);
              const pct = tot > 0 ? ((c.parsed/tot)*100).toFixed(1) + '%' : '—';
              return `${c.label}: ${fmt_n(c.parsed)} leads (${pct})`;
            }
          }
        }
      }
    }
  });
}

function chartCategoria(rows){
  destroyChart('categoria');
  const alto    = rows.reduce((a,r)=>a+(r.alto||0), 0);
  const medio   = rows.reduce((a,r)=>a+(r.medio||0), 0);
  const empuje  = rows.reduce((a,r)=>a+(r.empuje||0), 0);
  const aprInt  = rows.reduce((a,r)=>a+(r.aprobado_int||0), 0);
  const noNac   = rows.reduce((a,r)=>a+(r.no_aprobado_nac||0), 0);
  const noInt   = rows.reduce((a,r)=>a+(r.no_aprobado_int||0), 0);
  const sinClas = rows.reduce((a,r)=>a+(r.sin_clasificar||0), 0);

  const labels=[], values=[], colors=[];
  if (alto)    { labels.push('Alto');                   values.push(alto);   colors.push('#10b981'); }
  if (medio)   { labels.push('Medio');                  values.push(medio);  colors.push('#3b82f6'); }
  if (empuje)  { labels.push('Empuje');                 values.push(empuje); colors.push('#f59e0b'); }
  if (aprInt)  { labels.push('Aprobado Internacional'); values.push(aprInt); colors.push('#8b5cf6'); }
  if (noNac)   { labels.push('No Aprobado Nacional');   values.push(noNac);  colors.push('#ef4444'); }
  if (noInt)   { labels.push('No Aprobado Internac.');  values.push(noInt);  colors.push('#f87171'); }
  if (sinClas) { labels.push('Sin clasificar');         values.push(sinClas);colors.push('#9ca3af'); }

  const ctx = document.getElementById('chart-categoria');
  CHARTS.categoria = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 6 }]},
    options: {
      ...commonChartOpts(),
      indexAxis: 'y',
      plugins: { ...commonChartOpts().plugins, tooltip: { ...commonChartOpts().plugins.tooltip,
        callbacks: { label: (c) => `${fmt_n(c.parsed.x)} leads` }
      }},
      scales: { x:{...commonChartOpts().scales.x}, y:{...commonChartOpts().scales.y, grid:{display:false}}}
    }
  });
}

// =============================================================
// Detalle por canal — Meta y Google
// =============================================================
let META_LEVEL = 'campaign';
let GADS_LEVEL = 'campaign';
let META_SORT = {col:'spend', dir:-1};
let GADS_SORT = {col:'spend', dir:-1};

function aggregate(rows, keys){
  // rows: lista de objetos {fecha, campaign, adset, ad, spend, impressions, clicks}
  // keys: e.g. ['campaign'] o ['campaign','adset'] o ['campaign','adset','ad']
  const map = {};
  rows.forEach(r => {
    const k = keys.map(kk => r[kk] || '—').join(' / ');
    if (!map[k]) {
      map[k] = { key: k, ...Object.fromEntries(keys.map(kk => [kk, r[kk] || '—'])),
                 spend: 0, impressions: 0, clicks: 0 };
    }
    map[k].spend       += Number(r.spend || 0);
    map[k].impressions += Number(r.impressions || 0);
    map[k].clicks      += Number(r.clicks || 0);
  });
  return Object.values(map);
}

function attribLeadsByCampaign(){
  // Mapa: utm_campaign (Postgres) → {leads, aprobados}
  const map = {};
  (DATA.postgres_campaigns || []).forEach(p => {
    const k = p.campaign;
    if (!map[k]) map[k] = {leads:0, aprobados:0};
    map[k].leads     += p.leads || 0;
    map[k].aprobados += p.aprobados || 0;
  });
  return map;
}

function renderMetaDetail(rangeStart, rangeEnd){
  const rows = (DATA.meta_ads || []).filter(r => r.fecha >= rangeStart && r.fecha <= rangeEnd);
  const keys = META_LEVEL === 'campaign' ? ['campaign']
             : META_LEVEL === 'adset'    ? ['campaign','adset']
                                         : ['campaign','adset','ad'];
  const labelMap = {campaign:'Campaña', adset:'Conjunto', ad:'Anuncio'};
  document.getElementById('meta-detail-label').textContent = keys.map(k => labelMap[k]).join(' › ');

  const agg = aggregate(rows, keys);
  const leadsByCamp = attribLeadsByCampaign();
  // Atribuir leads/aprobados al nivel campaign (no podemos al adset/ad nivel desde hs_deals)
  agg.forEach(r => {
    const camp = r.campaign;
    r.leads     = (leadsByCamp[camp] || {leads:0}).leads;
    r.aprobados = (leadsByCamp[camp] || {aprobados:0}).aprobados;
    r.cpl       = r.leads     > 0 ? r.spend / r.leads     : null;
    r.cpl_ap    = r.aprobados > 0 ? r.spend / r.aprobados : null;
  });

  agg.sort((a,b) => {
    const va = a[META_SORT.col], vb = b[META_SORT.col];
    if (typeof va === 'string') return va.localeCompare(vb) * META_SORT.dir;
    return ((va||0) - (vb||0)) * META_SORT.dir;
  });
  const tbody = document.getElementById('meta-tbody');
  tbody.innerHTML = agg.map(r => {
    const label = keys.map(k => `<span class="text-gray-${k===keys[keys.length-1]?'900':'500'}">${r[k]}</span>`).join('<span class="text-gray-300 mx-1">›</span>');
    return `<tr>
      <td>${label}</td>
      <td class="font-medium">${fmt_s(r.spend)}</td>
      <td>${fmt_n(r.impressions)}</td>
      <td>${fmt_n(r.clicks)}</td>
      <td>${META_LEVEL==='campaign' ? fmt_n(r.leads) : '<span class="text-gray-300">—</span>'}</td>
      <td>${META_LEVEL==='campaign' ? fmt_n(r.aprobados) : '<span class="text-gray-300">—</span>'}</td>
      <td>${META_LEVEL==='campaign' && r.cpl    ? fmt_s(r.cpl)    : '<span class="text-gray-300">—</span>'}</td>
      <td>${META_LEVEL==='campaign' && r.cpl_ap ? fmt_s(r.cpl_ap) : '<span class="text-gray-300">—</span>'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="text-center text-gray-400 py-6">Sin datos en el rango</td></tr>`;
}

function renderGadsDetail(rangeStart, rangeEnd){
  const source = GADS_LEVEL === 'campaign' ? (DATA.gads_campaigns || []) : (DATA.gads_asset_groups || []);
  const rows = source.filter(r => r.fecha >= rangeStart && r.fecha <= rangeEnd);
  const keys = GADS_LEVEL === 'campaign' ? ['campaign'] : ['campaign','asset_group'];
  const labelMap = {campaign:'Campaña', asset_group:'Asset Group'};
  document.getElementById('gads-detail-label').textContent = keys.map(k => labelMap[k]).join(' › ');

  const agg = aggregate(rows, keys);
  // Atribuir leads de Google (canal Google) desde postgres_campaigns
  const googleLeads = {leads:0, aprobados:0};
  (DATA.postgres_campaigns || []).forEach(p => {
    if (p.canal === 'Google') {
      googleLeads.leads     += p.leads || 0;
      googleLeads.aprobados += p.aprobados || 0;
    }
  });

  agg.forEach(r => {
    // Para Google PMax, atribuir todo a la campaña (1 sola campaña LANDING usualmente)
    if (GADS_LEVEL === 'campaign') {
      r.leads     = googleLeads.leads;
      r.aprobados = googleLeads.aprobados;
      r.cpl       = r.leads     > 0 ? r.spend / r.leads     : null;
      r.cpl_ap    = r.aprobados > 0 ? r.spend / r.aprobados : null;
    }
  });

  agg.sort((a,b) => {
    const va = a[GADS_SORT.col], vb = b[GADS_SORT.col];
    if (typeof va === 'string') return va.localeCompare(vb) * GADS_SORT.dir;
    return ((va||0) - (vb||0)) * GADS_SORT.dir;
  });
  const tbody = document.getElementById('gads-tbody');
  tbody.innerHTML = agg.map(r => {
    const label = keys.map(k => `<span class="text-gray-${k===keys[keys.length-1]?'900':'500'}">${r[k]}</span>`).join('<span class="text-gray-300 mx-1">›</span>');
    return `<tr>
      <td>${label}</td>
      <td class="font-medium">${fmt_s(r.spend)}</td>
      <td>${fmt_n(r.impressions)}</td>
      <td>${fmt_n(r.clicks)}</td>
      <td>${GADS_LEVEL==='campaign' ? fmt_n(r.leads) : '<span class="text-gray-300">—</span>'}</td>
      <td>${GADS_LEVEL==='campaign' ? fmt_n(r.aprobados) : '<span class="text-gray-300">—</span>'}</td>
      <td>${GADS_LEVEL==='campaign' && r.cpl    ? fmt_s(r.cpl)    : '<span class="text-gray-300">—</span>'}</td>
      <td>${GADS_LEVEL==='campaign' && r.cpl_ap ? fmt_s(r.cpl_ap) : '<span class="text-gray-300">—</span>'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="text-center text-gray-400 py-6">Sin datos en el rango</td></tr>`;
}

function renderTable(rows){
  const sorted = [...rows].sort((a,b) => {
    let va = a[SORT_COL], vb = b[SORT_COL];
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (typeof va === 'string') return va.localeCompare(vb) * SORT_DIR;
    return (va - vb) * SORT_DIR;
  });
  const tbody = document.getElementById('data-tbody');
  tbody.innerHTML = sorted.map(r => `
    <tr>
      <td class="text-gray-700">${fmt_d_view(r.fecha)}</td>
      <td class="font-medium">${fmt_s(r.total_spend)}</td>
      <td class="text-gray-600">${fmt_s(r.meta_spend)}</td>
      <td class="text-gray-600">${fmt_s(r.gads_spend)}</td>
      <td>${fmt_n(r.leads)}</td>
      <td class="text-emerald-600 font-medium">${fmt_n(r.aprobados)}</td>
      <td>${r.cpl ? fmt_s(r.cpl) : '<span class="text-gray-300">—</span>'}</td>
      <td>${r.cpl_aprobado ? fmt_s(r.cpl_aprobado) : '<span class="text-gray-300">—</span>'}</td>
    </tr>
  `).join('');
}

// ============================================================
// Embudo de conversión
// ============================================================
let FUNNEL_CANAL = '';
let FUNNEL_DIA   = '';

// Las reuniones (zoom) son lunes y miércoles — agregamos asistentes por SEMANA ISO
function weekKey(fechaStr){
  // ISO week start = lunes. Devuelve YYYY-Www
  const d = new Date(fechaStr + 'T12:00:00');
  const day = d.getDay() || 7;  // domingo=0 → 7
  d.setDate(d.getDate() - day + 1);  // mover a lunes
  return d.toISOString().slice(0,10);  // monday date as key
}

function weekLabel(mondayDateStr){
  const d = new Date(mondayDateStr + 'T12:00:00');
  const end = new Date(d); end.setDate(d.getDate() + 6);
  const fmt = (x) => `${String(x.getDate()).padStart(2,'0')}/${String(x.getMonth()+1).padStart(2,'0')}`;
  return `Sem ${fmt(d)}–${fmt(end)}`;
}

// Calcula asistentes acumulado SEMANAL para un set de filas, opcionalmente filtrado por canal
function weeklyAsistentes(rows, canal){
  const byWeek = {};  // {mondayKey: total}
  rows.forEach(r => {
    const wk = weekKey(r.fecha);
    let v;
    if (canal) {
      v = ((r.canales || {})[canal] || {}).asistentes || 0;
    } else {
      v = r.asistentes || 0;
    }
    byWeek[wk] = (byWeek[wk] || 0) + v;
  });
  return byWeek;
}

function renderFunnel(rangeRows){
  // Filtrar por día específico si está seteado
  let rows;
  let asistentesScope; // rango de filas usado para calcular asistentes (siempre semana completa)
  let asistentesLabel = '';
  if (FUNNEL_DIA) {
    // Día específico → asistentes acumulado de la SEMANA que contiene ese día
    rows = rangeRows.filter(r => r.fecha === FUNNEL_DIA);
    const targetWeek = weekKey(FUNNEL_DIA);
    asistentesScope = rangeRows.filter(r => weekKey(r.fecha) === targetWeek);
    asistentesLabel = ` (${weekLabel(targetWeek)})`;
  } else {
    rows = rangeRows;
    asistentesScope = rangeRows;
  }
  if (rows.length === 0) rows = rangeRows;

  // Agregar por canal o total (todo menos asistentes — para este usamos asistentesScope)
  const totals = { leads:0, aprobados:0, altos_medios:0, asistentes:0, simulados:0, cotizados:0 };
  const pick = (r) => FUNNEL_CANAL ? ((r.canales||{})[FUNNEL_CANAL] || {}) : r;
  const apr  = (r) => FUNNEL_CANAL
    ? ((r.canales||{})[FUNNEL_CANAL]||{}).alto + ((r.canales||{})[FUNNEL_CANAL]||{}).medio + ((r.canales||{})[FUNNEL_CANAL]||{}).empuje + ((r.canales||{})[FUNNEL_CANAL]||{}).aprobado_int
    : r.aprobados;
  const am   = (r) => FUNNEL_CANAL
    ? (((r.canales||{})[FUNNEL_CANAL]||{}).alto||0) + (((r.canales||{})[FUNNEL_CANAL]||{}).medio||0)
    : (r.altos_medios||0);

  rows.forEach(r => {
    const x = pick(r);
    totals.leads        += x.leads || 0;
    totals.aprobados    += apr(r) || 0;
    totals.altos_medios += am(r);
    totals.simulados    += x.simulados || 0;
    totals.cotizados    += x.cotizados || 0;
  });

  // Asistentes: usar la SEMANA completa que contiene los días filtrados
  asistentesScope.forEach(r => {
    const x = pick(r);
    totals.asistentes += x.asistentes || 0;
  });

  const stages = [
    { label: 'Leads',                              value: totals.leads,        color:'#3b82f6', width: 100 },
    { label: 'Leads Aprobados',                    value: totals.aprobados,    color:'#10b981', width:  85 },
    { label: 'Leads Altos / Medios',               value: totals.altos_medios, color:'#0d9488', width:  70 },
    { label: 'Asistentes al zoom' + asistentesLabel, value: totals.asistentes, color:'#8b5cf6', width:  55, footer: FUNNEL_DIA ? 'acumulado de la semana' : 'sumado en el rango' },
  ];

  const cont = document.getElementById('funnel-stages');
  let html = '';
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const footerHtml = s.footer ? `<div class="text-[10px] text-gray-400 mt-1">${s.footer}</div>` : '';
    html += `
      <div class="flex justify-center my-2">
        <div class="rounded-full border-2 px-6 py-4 text-center shadow-sm transition-all" style="width:${s.width}%; background:${s.color}15; border-color:${s.color}50">
          <div class="text-xs uppercase tracking-wide font-medium text-gray-500">${s.label}</div>
          <div class="text-2xl font-bold mt-1" style="color:${s.color}">${fmt_n(s.value)}</div>
          ${footerHtml}
        </div>
      </div>`;
    // Conversion % to next stage
    if (i < stages.length - 1) {
      const next = stages[i+1];
      const pct = s.value > 0 ? (next.value / s.value) * 100 : 0;
      const pctColor = pct >= 50 ? '#10b981' : pct >= 20 ? '#f59e0b' : '#ef4444';
      html += `
        <div class="flex justify-center items-center gap-2 text-xs my-1">
          <span class="text-gray-400">↓</span>
          <span style="color:${pctColor}" class="font-semibold">${pct.toFixed(1)}%</span>
          <span class="text-gray-400">conversión</span>
        </div>`;
    }
  }
  cont.innerHTML = html;

  // Tabla resumen — comportamiento depende del VIEW_MODE
  const tbody = document.getElementById('funnel-tbody');
  const weeklyAsist = weeklyAsistentes(rangeRows, FUNNEL_CANAL);
  let displayRows;
  if (VIEW_MODE === 'weekly') {
    displayRows = aggregateByWeek(FUNNEL_DIA ? rangeRows.filter(r => r.fecha === FUNNEL_DIA) : rangeRows);
  } else {
    displayRows = FUNNEL_DIA ? rangeRows.filter(r => r.fecha === FUNNEL_DIA) : rangeRows;
  }
  const sorted = [...displayRows].reverse();

  tbody.innerHTML = sorted.map(r => {
    let leads, aprobados, altos_medios, asist_dia, simul, cotiz;
    if (FUNNEL_CANAL) {
      const c = (r.canales||{})[FUNNEL_CANAL] || {};
      leads = c.leads || 0;
      aprobados = (c.alto||0)+(c.medio||0)+(c.empuje||0)+(c.aprobado_int||0);
      altos_medios = (c.alto||0)+(c.medio||0);
      asist_dia = c.asistentes || 0;
      simul = c.simulados || 0; cotiz = c.cotizados || 0;
    } else {
      leads = r.leads||0; aprobados = r.aprobados||0; altos_medios = r.altos_medios||0;
      asist_dia = r.asistentes || 0;
      simul = r.simulados||0; cotiz = r.cotizados||0;
    }

    if (VIEW_MODE === 'weekly') {
      // En semanal: solo una columna asistentes (el total de la semana)
      return `<tr>
        <td class="text-gray-700">${fmt_d_view(r.fecha)}</td>
        <td>${fmt_n(leads)}</td>
        <td class="text-emerald-600 font-medium">${fmt_n(aprobados)}</td>
        <td class="text-teal-600">${fmt_n(altos_medios)}</td>
        <td style="display:none"></td>
        <td class="text-violet-600">${fmt_n(asist_dia)}</td>
        <td>${fmt_n(simul)}</td>
        <td>${fmt_n(cotiz)}</td>
      </tr>`;
    }
    // Daily: 2 columnas asistentes (día + acumulado semana)
    const asistSemanaTotal = weeklyAsist[weekKey(r.fecha)] || 0;
    return `<tr>
      <td class="text-gray-700">${fmt_d_full(r.fecha)}</td>
      <td>${fmt_n(leads)}</td>
      <td class="text-emerald-600 font-medium">${fmt_n(aprobados)}</td>
      <td class="text-teal-600">${fmt_n(altos_medios)}</td>
      <td class="${asist_dia>0?'text-violet-600 font-medium':'text-gray-300'}">${fmt_n(asist_dia)}</td>
      <td title="Acumulado ${weekLabel(weekKey(r.fecha))}" class="text-violet-400">${fmt_n(asistSemanaTotal)}</td>
      <td>${fmt_n(simul)}</td>
      <td>${fmt_n(cotiz)}</td>
    </tr>`;
  }).join('');
}

function populateFunnelSelectors(){
  // Canales disponibles (juntar de todos los días)
  const canales = new Set();
  DATA.days.forEach(d => Object.keys(d.canales || {}).forEach(c => canales.add(c)));
  const canalSel = document.getElementById('funnel-canal');
  [...canales].sort().forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    canalSel.appendChild(o);
  });
  // Días en orden descendente
  const diaSel = document.getElementById('funnel-dia');
  [...DATA.days].reverse().forEach(d => {
    const o = document.createElement('option');
    o.value = d.fecha; o.textContent = fmt_d_full(d.fecha);
    diaSel.appendChild(o);
  });
  canalSel.addEventListener('change', () => { FUNNEL_CANAL = canalSel.value; render(); });
  diaSel.addEventListener('change',   () => { FUNNEL_DIA   = diaSel.value;   render(); });
}

function render(){
  const rangeDailyRows = pickRange(DATA.days, CURRENT_RANGE);
  const rows = VIEW_MODE === 'weekly' ? aggregateByWeek(rangeDailyRows) : rangeDailyRows;

  // Para la columna "Asist. sem" siempre necesitamos los daily rows (para weekKey lookup)
  renderKPIs(rows);
  renderFunnel(rangeDailyRows);  // funnel siempre usa daily para tener bien el weeklyAsistentes
  chartSpend(rows);
  chartLeads(rows);
  chartCPL(rows);
  chartCanales(rows);
  chartCategoria(rows);
  renderTable(rows);
  if (rangeDailyRows.length > 0) {
    const rs = rangeDailyRows[0].fecha, re = rangeDailyRows[rangeDailyRows.length-1].fecha;
    renderMetaDetail(rs, re);
    renderGadsDetail(rs, re);
  }

  // Toggle columnas Asist. día / Asist. sem según vista
  const thDia = document.getElementById('th-asist-dia');
  const thSem = document.getElementById('th-asist-sem');
  if (VIEW_MODE === 'weekly') {
    thDia.style.display = 'none';
    thSem.textContent = 'Asistentes';
    thSem.removeAttribute('title');
  } else {
    thDia.style.display = '';
    thSem.textContent = 'Asist. sem';
    thSem.setAttribute('title', 'Acumulado de la semana (Lun-Dom)');
  }
}

async function init(){
  const resp = await fetch('./data.json');
  DATA = await resp.json();
  document.getElementById('updated-at').textContent =
    new Date(DATA.generated_at).toLocaleString('es-PE', {dateStyle:'medium', timeStyle:'short'});

  // Populate funnel filters
  populateFunnelSelectors();

  // View mode toggle (daily / weekly)
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
      btn.classList.remove('pill-inactive'); btn.classList.add('pill-active');
      VIEW_MODE = btn.dataset.view;
      render();
    });
  });

  // Range preset buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
      btn.classList.remove('pill-inactive'); btn.classList.add('pill-active');
      CURRENT_RANGE = btn.dataset.range;
      // limpiar daterange visual
      const dr = window.__daterangePicker;
      if (dr) dr.clear();
      render();
    });
  });

  // ========================================================
  // Flatpickr range picker (estilo Meta — 2 meses, range mode)
  // FIX TZ: NO pasar strings YYYY-MM-DD a Date() (se interpretan como UTC).
  // Usar constructor local: new Date(y, m-1, d) → respeta TZ del browser.
  // ========================================================
  const parseLocal = (s) => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
  const fmtLocal   = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const earliestStr = DATA.days[0].fecha;
  const latestStr   = DATA.days[DATA.days.length-1].fecha;
  const earliestDt  = parseLocal(earliestStr);
  const latestDt    = parseLocal(latestStr);

  // Default month focus: que el calendario abra mostrando el último mes con datos
  const defaultMonthDt = parseLocal(latestStr);

  window.__daterangePicker = flatpickr('#daterange', {
    mode: 'range',
    locale: 'es',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'd M Y',
    minDate: earliestDt,             // Date object local
    maxDate: latestDt,                // Date object local
    defaultDate: [parseLocal(DATA.days[Math.max(0, DATA.days.length-30)].fecha), latestDt],
    showMonths: window.innerWidth > 720 ? 2 : 1,
    disableMobile: true,
    // No mostrar el calendario en posición sobre el body — keep flat
    onChange: (selectedDates) => {
      if (selectedDates.length === 2) {
        CUSTOM_FROM = fmtLocal(selectedDates[0]);
        CUSTOM_TO   = fmtLocal(selectedDates[1]);
        CURRENT_RANGE = 'custom';
        document.querySelectorAll('.range-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
        render();
      }
    },
    onReady: (selectedDates, dateStr, instance) => {
      // Posicionar el calendario en el mes más reciente con data (no en "hoy" del browser)
      instance.jumpToDate(defaultMonthDt, false);

      // Mini-presets dentro del calendario — relativos al ÚLTIMO DÍA con data
      const presets = document.createElement('div');
      presets.className = 'daterange-presets';
      const opts = [
        ['Hoy',       0,  0],
        ['Ayer',      1,  1],
        ['7 días',    6,  0],
        ['14 días',  13,  0],
        ['30 días',  29,  0],
        ['Mes actual','mtd', null],
        ['Mes pasado','prev', null],
      ];
      opts.forEach(([label, a, b]) => {
        const btn = document.createElement('button');
        btn.textContent = label; btn.type = 'button';
        btn.onclick = (e) => {
          e.preventDefault();
          let start, end;
          // Referencia = último día con data (no "hoy" del browser para evitar saltos de calendario)
          const ref = new Date(latestDt);
          if (a === 'mtd') {
            start = new Date(ref.getFullYear(), ref.getMonth(), 1);
            end   = ref;
          } else if (a === 'prev') {
            start = new Date(ref.getFullYear(), ref.getMonth()-1, 1);
            end   = new Date(ref.getFullYear(), ref.getMonth(), 0);  // último día mes anterior
          } else {
            end   = new Date(ref); end.setDate(ref.getDate() - b);
            start = new Date(ref); start.setDate(ref.getDate() - a);
          }
          if (start < earliestDt) start = new Date(earliestDt);
          if (end   > latestDt)   end   = new Date(latestDt);
          instance.setDate([start, end], true);
        };
        presets.appendChild(btn);
      });
      instance.calendarContainer.appendChild(presets);
    }
  });

  // Tabs Meta/Google
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('bg-white','shadow','text-blue-600');
        b.classList.add('text-gray-600');
      });
      btn.classList.add('bg-white','shadow','text-blue-600');
      btn.classList.remove('text-gray-600');
      document.getElementById('tab-meta').classList.toggle('hidden', target !== 'meta');
      document.getElementById('tab-google').classList.toggle('hidden', target !== 'google');
    });
  });

  // Sub-niveles Meta
  document.querySelectorAll('.meta-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.meta-level-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
      btn.classList.remove('pill-inactive'); btn.classList.add('pill-active');
      META_LEVEL = btn.dataset.metaLevel;
      const rows = pickRange(DATA.days, CURRENT_RANGE);
      if (rows.length) renderMetaDetail(rows[0].fecha, rows[rows.length-1].fecha);
    });
  });
  // Sub-niveles Google
  document.querySelectorAll('.gads-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gads-level-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
      btn.classList.remove('pill-inactive'); btn.classList.add('pill-active');
      GADS_LEVEL = btn.dataset.gadsLevel;
      const rows = pickRange(DATA.days, CURRENT_RANGE);
      if (rows.length) renderGadsDetail(rows[0].fecha, rows[rows.length-1].fecha);
    });
  });

  // Sort headers
  document.querySelectorAll('.data-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (SORT_COL === col) SORT_DIR *= -1;
      else { SORT_COL = col; SORT_DIR = -1; }
      const rows = pickRange(DATA.days, CURRENT_RANGE);
      renderTable(rows);
    });
  });

  render();
}

init().catch(e => {
  console.error(e);
  document.body.innerHTML = `<div class="p-8 text-center text-red-600">Error cargando data: ${e.message}</div>`;
});
