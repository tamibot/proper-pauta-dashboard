// ============================================================================
// Dashboard de Inversión en Pauta — vanilla JS + Chart.js
// ============================================================================
const COLORS = {
  meta:    '#1877f2',
  google:  '#fbbc04',
  leads:   '#3b82f6',
  apr:     '#10b981',
  cpl:     '#6366f1',
  cplAp:   '#a78bfa',
  facebook: '#1877f2',
  instagram:'#e1306c',
  google_c: '#fbbc04',
  an:       '#34d399',
  otros:    '#9ca3af',
};

let DATA = null;
let CURRENT_RANGE = 30;
let SORT_COL = 'fecha';
let SORT_DIR = -1;  // desc

const fmt_s   = v => 'S/' + (Number(v||0)).toLocaleString('es-PE', {minimumFractionDigits:2, maximumFractionDigits:2});
const fmt_n   = v => (Number(v||0)).toLocaleString('es-PE');
const fmt_pct = v => v == null ? '—' : (v*100).toFixed(1) + '%';
const fmt_d   = d => { const [y,m,dd] = d.split('-'); return `${dd}/${m}`; };
const fmt_d_full = d => new Date(d+'T00:00').toLocaleDateString('es-PE', {weekday:'short', day:'2-digit', month:'short'});

function pickRange(days, rangeKey){
  if (rangeKey === 'mtd') {
    const today = new Date();
    const first = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-01';
    return days.filter(d => d.fecha >= first);
  }
  const n = parseInt(rangeKey, 10);
  // últimos N días con datos
  return days.slice(-n);
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
      labels: rows.map(r => fmt_d(r.fecha)),
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
            title: (items) => fmt_d_full(rows[items[0].dataIndex].fecha),
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
    type: 'line',
    data: {
      labels: rows.map(r => fmt_d(r.fecha)),
      datasets: [
        { label:'Leads',     data: rows.map(r=>r.leads),     borderColor: COLORS.leads, backgroundColor:'rgba(59,130,246,0.08)', tension:.3, fill:true, pointRadius:3, pointHoverRadius:5, borderWidth:2 },
        { label:'Aprobados', data: rows.map(r=>r.aprobados), borderColor: COLORS.apr,   backgroundColor:'rgba(16,185,129,0.06)', tension:.3, fill:true, pointRadius:3, pointHoverRadius:5, borderWidth:2 }
      ]
    },
    options: {
      ...commonChartOpts(),
      plugins: { ...commonChartOpts().plugins, tooltip: { ...commonChartOpts().plugins.tooltip,
        callbacks: { title: (items) => fmt_d_full(rows[items[0].dataIndex].fecha) }
      }}
    }
  });
}

function chartCPL(rows){
  destroyChart('cpl');
  const ctx = document.getElementById('chart-cpl');
  CHARTS.cpl = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmt_d(r.fecha)),
      datasets: [
        { label:'CPL',          data: rows.map(r=>r.cpl),          borderColor: COLORS.cpl,   tension:.3, pointRadius:3, borderWidth:2, spanGaps:true },
        { label:'CPL Aprobado', data: rows.map(r=>r.cpl_aprobado), borderColor: COLORS.cplAp, tension:.3, pointRadius:3, borderWidth:2, spanGaps:true }
      ]
    },
    options: {
      ...commonChartOpts(),
      plugins: { ...commonChartOpts().plugins, tooltip: { ...commonChartOpts().plugins.tooltip,
        callbacks: {
          title: (items) => fmt_d_full(rows[items[0].dataIndex].fecha),
          label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '—' : fmt_s(c.parsed.y)}`
        }
      }}
    }
  });
}

function chartCanales(rows){
  destroyChart('canales');
  // Sumar leads por canal en el rango
  const totalsByCanal = {};
  rows.forEach(r => {
    Object.entries(r.canales || {}).forEach(([c, info]) => {
      if (!totalsByCanal[c]) totalsByCanal[c] = 0;
      totalsByCanal[c] += info.leads;
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
  const alto       = rows.reduce((a,r)=>a+(r.alto||0), 0);
  const medio      = rows.reduce((a,r)=>a+(r.medio||0), 0);
  const empuje     = rows.reduce((a,r)=>a+(r.empuje||0), 0);
  const noAprobado = rows.reduce((a,r)=>a+(r.no_aprobado||0), 0);
  const sinIngreso = rows.reduce((a,r)=>a+(r.sin_ingreso||0), 0);
  const ctx = document.getElementById('chart-categoria');
  CHARTS.categoria = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Alto', 'Medio', 'Empuje', 'No Aprobado', 'Sin ingreso'],
      datasets: [{
        data: [alto, medio, empuje, noAprobado, sinIngreso],
        backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#9ca3af'],
        borderRadius: 6
      }]
    },
    options: {
      ...commonChartOpts(),
      indexAxis: 'y',
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

function renderMetaDetail(rangeStart, rangeEnd){
  const rows = (DATA.meta_ads || []).filter(r => r.fecha >= rangeStart && r.fecha <= rangeEnd);
  const keys = META_LEVEL === 'campaign' ? ['campaign']
             : META_LEVEL === 'adset'    ? ['campaign','adset']
                                         : ['campaign','adset','ad'];
  const labelMap = {campaign:'Campaña', adset:'Conjunto', ad:'Anuncio'};
  document.getElementById('meta-detail-label').textContent = keys.map(k => labelMap[k]).join(' › ');

  const agg = aggregate(rows, keys);
  agg.sort((a,b) => {
    const va = a[META_SORT.col], vb = b[META_SORT.col];
    if (typeof va === 'string') return va.localeCompare(vb) * META_SORT.dir;
    return ((va||0) - (vb||0)) * META_SORT.dir;
  });
  const tbody = document.getElementById('meta-tbody');
  tbody.innerHTML = agg.map(r => {
    const cpc = r.clicks > 0 ? r.spend / r.clicks : null;
    const ctr = r.impressions > 0 ? r.clicks / r.impressions : null;
    const label = keys.map(k => `<span class="text-gray-${k===keys[keys.length-1]?'900':'500'}">${r[k]}</span>`).join('<span class="text-gray-300 mx-1">›</span>');
    return `<tr>
      <td>${label}</td>
      <td class="font-medium">${fmt_s(r.spend)}</td>
      <td>${fmt_n(r.impressions)}</td>
      <td>${fmt_n(r.clicks)}</td>
      <td>${cpc ? fmt_s(cpc) : '<span class="text-gray-300">—</span>'}</td>
      <td>${ctr ? (ctr*100).toFixed(2)+'%' : '<span class="text-gray-300">—</span>'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="text-center text-gray-400 py-6">Sin datos en el rango</td></tr>`;
}

function renderGadsDetail(rangeStart, rangeEnd){
  const source = GADS_LEVEL === 'campaign' ? (DATA.gads_campaigns || []) : (DATA.gads_asset_groups || []);
  const rows = source.filter(r => r.fecha >= rangeStart && r.fecha <= rangeEnd);
  const keys = GADS_LEVEL === 'campaign' ? ['campaign'] : ['campaign','asset_group'];
  const labelMap = {campaign:'Campaña', asset_group:'Asset Group'};
  document.getElementById('gads-detail-label').textContent = keys.map(k => labelMap[k]).join(' › ');

  const agg = aggregate(rows, keys);
  agg.sort((a,b) => {
    const va = a[GADS_SORT.col], vb = b[GADS_SORT.col];
    if (typeof va === 'string') return va.localeCompare(vb) * GADS_SORT.dir;
    return ((va||0) - (vb||0)) * GADS_SORT.dir;
  });
  const tbody = document.getElementById('gads-tbody');
  tbody.innerHTML = agg.map(r => {
    const cpc = r.clicks > 0 ? r.spend / r.clicks : null;
    const ctr = r.impressions > 0 ? r.clicks / r.impressions : null;
    const label = keys.map(k => `<span class="text-gray-${k===keys[keys.length-1]?'900':'500'}">${r[k]}</span>`).join('<span class="text-gray-300 mx-1">›</span>');
    return `<tr>
      <td>${label}</td>
      <td class="font-medium">${fmt_s(r.spend)}</td>
      <td>${fmt_n(r.impressions)}</td>
      <td>${fmt_n(r.clicks)}</td>
      <td>${cpc ? fmt_s(cpc) : '<span class="text-gray-300">—</span>'}</td>
      <td>${ctr ? (ctr*100).toFixed(2)+'%' : '<span class="text-gray-300">—</span>'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="text-center text-gray-400 py-6">Sin datos en el rango</td></tr>`;
}

function renderTable(rows){
  // Sort
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
      <td class="text-gray-700">${fmt_d_full(r.fecha)}</td>
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

function render(){
  const rows = pickRange(DATA.days, CURRENT_RANGE);
  renderKPIs(rows);
  chartSpend(rows);
  chartLeads(rows);
  chartCPL(rows);
  chartCanales(rows);
  chartCategoria(rows);
  renderTable(rows);
  // Rango de fechas para el detalle por canal
  if (rows.length > 0) {
    const rs = rows[0].fecha, re = rows[rows.length-1].fecha;
    renderMetaDetail(rs, re);
    renderGadsDetail(rs, re);
  }
}

async function init(){
  const resp = await fetch('./data.json');
  DATA = await resp.json();
  document.getElementById('updated-at').textContent =
    new Date(DATA.generated_at).toLocaleString('es-PE', {dateStyle:'medium', timeStyle:'short'});

  // Range buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => { b.classList.remove('pill-active'); b.classList.add('pill-inactive'); });
      btn.classList.remove('pill-inactive');
      btn.classList.add('pill-active');
      CURRENT_RANGE = btn.dataset.range;
      render();
    });
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
