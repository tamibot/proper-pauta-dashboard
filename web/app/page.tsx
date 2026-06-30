"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Chart from "chart.js/auto";
import * as B from "@/lib/budget";
import { ChannelLogo } from "@/lib/logos";

type Theme = "light" | "dark";
type RefreshState = "idle" | "loading" | "success" | "fail";

export default function BudgetPage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [refresh, setRefresh] = useState<RefreshState>("idle");
  const [range, setRange] = useState(30);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [openCampaigns, setOpenCampaigns] = useState<Record<string, boolean>>({});
  const [hiddenSeries, setHiddenSeries] = useState<Record<string, boolean>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  /* ---------- initial load + theme ---------- */
  useEffect(() => {
    const saved = ((typeof localStorage !== "undefined" &&
      localStorage.getItem("budget-theme-v2")) as Theme) || "light";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData(force = false) {
    try {
      const r = await fetch("/api/data" + (force ? `?cb=${Date.now()}` : ""));
      const j = await r.json();
      if (!j.data) {
        setErr(j.error || "No hay datos cargados todavía.");
        return;
      }
      setErr(null);
      setData(j.data);
      const months = B.buildMonthsList(j.data);
      setMonthKey((prev) => prev || months.find((m) => m.isCurrent)?.key || months[0]?.key || null);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  function toggleTheme() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("budget-theme-v2", next);
  }

  async function triggerRefresh() {
    if (refresh === "loading") return;
    setRefresh("loading");
    try {
      const r = await fetch("/api/refresh", { method: "POST" });
      const j = await r.json();
      if (!j.ok || !j.data) throw new Error(j.error || "refresh falló");
      setData(j.data);
      setRefresh("success");
    } catch {
      setRefresh("fail");
    } finally {
      setTimeout(() => setRefresh("idle"), 1800);
    }
  }

  /* ---------- derived ---------- */
  const months = useMemo(() => (data ? B.buildMonthsList(data) : []), [data]);
  const md = useMemo(
    () => (data && monthKey ? B.getMonthData(monthKey, data) : null),
    [data, monthKey],
  );
  const alerts = useMemo(() => (md ? B.getAlerts(md) : []), [md]);

  const chartDays = useMemo(() => {
    if (!data || !md) return [];
    if (md.isCurrent) return (data.days || []).slice(-range);
    const prefix = md.key + "-";
    return (data.days || []).filter((d: any) => (d.fecha || "").startsWith(prefix));
  }, [data, md, range]);

  /* ---------- chart ---------- */
  useEffect(() => {
    if (!canvasRef.current || !chartDays.length) {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
      return;
    }
    const css = getComputedStyle(document.documentElement);
    const cv = (n: string) => css.getPropertyValue(n).trim();
    const isDark = theme === "dark";
    const colorMeta = "#1877F2";
    const colorGoogle = "#4285F4";
    const muted = cv("--muted");
    const border = cv("--border");
    const bgCard = cv("--bg-card");

    const labels = chartDays.map((d: any) => {
      const [, m, dd] = (d.fecha || "").split("-");
      return `${dd}/${m}`;
    });
    const metaData = chartDays.map((d: any) => Number(d.meta_spend) || 0);
    const googleData = chartDays.map((d: any) => Number(d.gads_spend) || 0);

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Meta Ads",
            data: metaData,
            borderColor: colorMeta,
            backgroundColor: colorMeta + "14",
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: bgCard,
            pointHoverBorderColor: colorMeta,
            pointHoverBorderWidth: 2,
            tension: 0.32,
            fill: true,
            hidden: !!hiddenSeries.meta,
          },
          {
            label: "Google Ads",
            data: googleData,
            borderColor: colorGoogle,
            backgroundColor: "transparent",
            borderWidth: 1.8,
            borderDash: [4, 3],
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: bgCard,
            pointHoverBorderColor: colorGoogle,
            pointHoverBorderWidth: 2,
            tension: 0.32,
            hidden: !!hiddenSeries.google,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500, easing: "easeOutCubic" },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? "#1B1F26" : "#101828",
            titleColor: "#F2F4F7",
            bodyColor: "#F2F4F7",
            borderColor: isDark ? "#353B45" : "rgba(0,0,0,0)",
            borderWidth: isDark ? 1 : 0,
            padding: 12,
            cornerRadius: 8,
            displayColors: true,
            boxWidth: 8,
            boxHeight: 8,
            boxPadding: 6,
            callbacks: {
              title: (items: any) => items[0]?.label,
              label: (ctx: any) => `  ${ctx.dataset.label}  S/ ${B.fmt(ctx.parsed.y, 2)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: border, width: 1 },
            ticks: { color: muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 20, font: { size: 11 } },
          },
          y: {
            beginAtZero: true,
            grid: { color: border, drawTicks: false },
            border: { display: false },
            ticks: { color: muted, padding: 10, font: { size: 11 }, callback: (v: any) => "S/ " + B.fmt(v, 0) },
          },
        },
      },
    });
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [chartDays, theme, hiddenSeries]);

  /* ---------- chart stats ---------- */
  const chartStats = useMemo(() => {
    const sumM = chartDays.reduce((a: number, d: any) => a + (Number(d.meta_spend) || 0), 0);
    const sumG = chartDays.reduce((a: number, d: any) => a + (Number(d.gads_spend) || 0), 0);
    const tot = sumM + sumG;
    const n = Math.max(chartDays.length, 1);
    const maxMv = Math.max(0, ...chartDays.map((d: any) => Number(d.meta_spend) || 0));
    const maxMi = chartDays.findIndex((d: any) => (Number(d.meta_spend) || 0) === maxMv);
    return {
      avgM: sumM / n, avgG: sumG / n, tot, maxMv,
      maxMdate: chartDays[maxMi]?.fecha?.slice(5) || "—",
      shareM: Math.round((sumM / Math.max(tot, 1)) * 100),
      shareG: Math.round((sumG / Math.max(tot, 1)) * 100),
    };
  }, [chartDays]);

  /* ---------- close selector on outside click ---------- */
  useEffect(() => {
    if (!selectorOpen) return;
    const h = (e: MouseEvent) => {
      const el = document.getElementById("month-select");
      if (el && !el.contains(e.target as Node)) setSelectorOpen(false);
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [selectorOpen]);

  /* ===================== RENDER ===================== */
  const curOpt = months.find((m) => m.key === monthKey) || months[0];

  return (
    <>
      {/* TOPBAR */}
      <div className="topbar">
        <div className="container topbar-inner">
          <div className="brand">
            <div className="brand-mark">P</div>
            <span>Proper</span>
            <span className="brand-sep">/</span>
            <span className="brand-sub">Pauta</span>
          </div>
          <div className="topbar-actions">
            <button className="btn btn-icon" onClick={toggleTheme} aria-label="Cambiar tema">
              {theme === "dark" ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              )}
            </button>
            <button className={`btn ${refresh === "loading" ? "loading" : ""} ${refresh === "success" ? "success" : ""} ${refresh === "fail" ? "fail" : ""}`} onClick={triggerRefresh} disabled={refresh === "loading"}>
              <svg className="btn-refresh-ico" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></svg>
              <span>{refresh === "loading" ? "Actualizando…" : refresh === "success" ? "Actualizado" : refresh === "fail" ? "Error" : "Actualizar"}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="container">
        {/* PAGE HEAD */}
        <div className="page-head">
          <div>
            <h1>Presupuesto</h1>
            <div className="sub">
              {md
                ? md.isCurrent
                  ? `${B.monthDisplay(md)} · día ${md.daysE} de ${md.daysIn} · ${B.pct(md.pctMonth, 1)} del mes corrido`
                  : `${B.monthDisplay(md)} · mes cerrado · ${md.daysIn} días`
                : "cargando…"}
            </div>
          </div>

          {curOpt && (
            <div className="month-select" id="month-select">
              <button className={`month-select-trigger ${selectorOpen ? "open" : ""}`} onClick={(e) => { e.stopPropagation(); setSelectorOpen((v) => !v); }}>
                <span className="label">
                  <span className="label-main">{B.monthDisplay(curOpt)}</span>
                  <span className="label-sub">
                    {curOpt.isPartial ? `día ${curOpt.daysCounted} de ${curOpt.daysIn}` : `${curOpt.daysIn} días · cerrado`} · {B.sl(curOpt.total, 0)}
                  </span>
                </span>
                <svg className="chev" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              <div className={`month-select-panel ${selectorOpen ? "open" : ""}`} role="listbox">
                {months.map((m) => {
                  const pctCls = m.isPartial ? "" : m.pct > 105 ? "over" : m.pct > 95 ? "warn" : "ok";
                  return (
                    <div
                      key={m.key}
                      className={`month-option ${m.isCurrent ? "is-current" : ""} ${m.key === monthKey ? "selected" : ""}`}
                      role="option"
                      onClick={() => { setMonthKey(m.key); setSelectorOpen(false); setRange(30); }}
                    >
                      <span className="opt-dot" />
                      <span className="opt-label">
                        <span className="opt-name">{B.monthDisplay(m)}</span>
                        <span className="opt-sub">{B.sl(m.total, 0)} · {B.pctI(m.pct)} del tope</span>
                      </span>
                      <span className={`opt-pct ${pctCls}`}>{B.pctI(m.pct)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {err && <div className="err">{err}</div>}

        {md && (
          <>
            <HeroSection md={md} />
            {alerts.length > 0 && <AlertsSection alerts={alerts} />}
            <ProductsSection md={md} openCampaigns={openCampaigns} setOpenCampaigns={setOpenCampaigns} />

            {/* CHART */}
            <section className="section">
              <div className="section-head">
                <div>
                  <h2 className="section-title">Ritmo diario por plataforma</h2>
                  <div className="section-desc">
                    {md.isCurrent ? "Spend diario de Meta y Google — pasá el cursor para ver los valores exactos." : `Spend diario en ${B.monthDisplay(md)}.`}
                  </div>
                </div>
              </div>
              <article className="card chart-card">
                <div className="chart-toolbar">
                  <div className="chart-legend">
                    <span className={`legend-item ${hiddenSeries.meta ? "muted" : ""}`} onClick={() => setHiddenSeries((s) => ({ ...s, meta: !s.meta }))}>
                      <ChannelLogo channelKey="facebook" size={14} /><span>Meta Ads</span>
                    </span>
                    <span className={`legend-item ${hiddenSeries.google ? "muted" : ""}`} onClick={() => setHiddenSeries((s) => ({ ...s, google: !s.google }))}>
                      <ChannelLogo channelKey="google" size={14} /><span>Google Ads</span>
                    </span>
                  </div>
                  {md.isCurrent ? (
                    <div className="range-tabs">
                      {[7, 14, 30, 60].map((n) => (
                        <button key={n} className={`range-tab ${range === n ? "active" : ""}`} onClick={() => setRange(n)}>{n}d</button>
                      ))}
                    </div>
                  ) : (
                    <div className="range-tabs" style={{ opacity: 0.7, pointerEvents: "none" }}>
                      <button className="range-tab active">{chartDays.length}d · mes completo</button>
                    </div>
                  )}
                </div>
                <div className="chart-wrap">
                  {chartDays.length ? <canvas ref={canvasRef} /> : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--muted)", fontSize: 13 }}>Sin días para este mes.</div>}
                </div>
                {chartDays.length > 0 && (
                  <div className="chart-stats">
                    <div className="chart-stat"><div className="chart-stat-lbl">Promedio Meta</div><div className="chart-stat-val"><span className="cur">S/</span>{B.fmt(chartStats.avgM, 0)}</div><div className="chart-stat-sub">por día · {chartDays.length}d</div></div>
                    <div className="chart-stat"><div className="chart-stat-lbl">Promedio Google</div><div className="chart-stat-val"><span className="cur">S/</span>{B.fmt(chartStats.avgG, 0)}</div><div className="chart-stat-sub">por día · {chartDays.length}d</div></div>
                    <div className="chart-stat"><div className="chart-stat-lbl">Pico Meta</div><div className="chart-stat-val"><span className="cur">S/</span>{B.fmt(chartStats.maxMv, 0)}</div><div className="chart-stat-sub">el {chartStats.maxMdate}</div></div>
                    <div className="chart-stat"><div className="chart-stat-lbl">Reparto del gasto</div><div className="chart-stat-val">{chartStats.shareM}<span className="cur"> · </span>{chartStats.shareG}</div><div className="chart-stat-sub">Meta / Google · total {B.sl(chartStats.tot, 0)}</div></div>
                  </div>
                )}
              </article>
            </section>

            <HistorySection data={data} budget={md.total?.budget || 9300} onPick={(k) => { setMonthKey(k); setRange(30); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
          </>
        )}

        <div className="footer">
          <div>Fuente: snapshot en Postgres · ETL build_data.py</div>
          <div>{data?.generated_at ? `Generado ${new Date(data.generated_at).toLocaleString("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</div>
        </div>
      </div>
    </>
  );
}

/* ===================== HERO ===================== */
function HeroSection({ md }: { md: B.MonthData }) {
  const total = md.total;
  const isCur = md.isCurrent;
  const ritmoActual = total.pct_used || 0;
  const ritmoIdeal = md.pctMonth;
  const diff = (total.budget || 0) - md.totalProj;

  let proyCls = "delta-up", proyArrow = "↓", proyTxt = "bajo el tope";
  if (diff < -(total.budget || 0) * 0.02) { proyCls = "delta-down"; proyArrow = "↑"; proyTxt = "sobre el tope"; }
  else if (diff < (total.budget || 0) * 0.02) { proyCls = "delta-warn"; proyArrow = "≈"; proyTxt = "al filo"; }

  const metaSub = isCur
    ? `en ${md.metaDaysWithSpend} días con gasto · proyecta ${B.sl(md.metaProj, 0)}`
    : `${md.metaDaysWithSpend} días con gasto · total ${B.sl(md.metaMtd, 0)}`;
  const googleSub = isCur
    ? `en ${md.googleDaysWithSpend} días con gasto · proyecta ${B.sl(md.googleProj, 0)}`
    : `${md.googleDaysWithSpend} días con gasto · total ${B.sl(md.googleMtd, 0)}`;

  return (
    <section className="section">
      <article className="card hero">
        <div className="hero-top">
          <div>
            <div className="hero-num"><span className="cur">S/</span>{B.fmt(total.mtd, 0)}</div>
            <div className="hero-lbl"
              dangerouslySetInnerHTML={{
                __html: isCur
                  ? `Gastado este mes · de <strong>${B.sl(total.budget, 0)}</strong>`
                  : `Total gastado en ${B.monthDisplay(md).split(" ")[0]} · tope ref. <strong>${B.sl(total.budget, 0)}</strong>`,
              }}
            />
          </div>
          <div className="hero-right">
            <div className="hero-pct">{B.pct(total.pct_used, 1)}</div>
            <div className="hero-pct-lbl">del tope usado</div>
          </div>
        </div>

        <div className="progress">
          <div className={`progress-fill ${ritmoActual > 100 ? "over" : isCur && ritmoActual > ritmoIdeal + 10 ? "warn" : ""}`} style={{ width: `${Math.min(ritmoActual, 100)}%` }} />
          {isCur && <div className="progress-marker" style={{ left: `${Math.min(ritmoIdeal, 100)}%` }} />}
        </div>
        <div className="progress-foot">
          <span>0%</span>
          {isCur ? <span className="ideal">ritmo ideal · {B.pct(ritmoIdeal, 1)}</span> : <span style={{ color: "var(--muted-2)" }}>mes cerrado · {md.daysIn} días</span>}
          <span>tope · {B.sl(total.budget, 0)}</span>
        </div>

        <div className="hero-stats">
          <div className="hero-stat">
            <div className="hero-stat-lbl"><ChannelLogo channelKey="facebook" size={14} /> {isCur ? "Ritmo Meta" : "Promedio Meta"}</div>
            <div className="hero-stat-val"><span className="cur">S/</span>{B.fmt(md.metaDaily, 0)}<span className="unit"> /día</span></div>
            <div className="hero-stat-sub">{metaSub}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-lbl"><ChannelLogo channelKey="google" size={14} /> {isCur ? "Ritmo Google" : "Promedio Google"}</div>
            <div className="hero-stat-val"><span className="cur">S/</span>{B.fmt(md.googleDaily, 0)}<span className="unit"> /día</span></div>
            <div className="hero-stat-sub">{googleSub}</div>
          </div>
          <div className="hero-stat">
            <div className="hero-stat-lbl">{isCur ? "Proyección si seguimos así" : "Total final"}</div>
            <div className="hero-stat-val"><span className="cur">S/</span>{B.fmt(md.totalProj, 0)}</div>
            <div className="hero-stat-sub">
              <span className={`delta ${proyCls}`}>{proyArrow}{B.sl(Math.abs(diff), 0)}</span> {proyTxt}
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}

/* ===================== ALERTS ===================== */
function AlertsSection({ alerts }: { alerts: B.Alert[] }) {
  const crit = alerts.filter((a) => a.severity === "critical").length;
  const high = alerts.filter((a) => a.severity === "high").length;
  const med = alerts.filter((a) => a.severity === "medium").length;
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">Atención</h2>
          <div className="section-desc">
            {alerts.length === 1 ? "1 canal necesita atención" : `${alerts.length} canales necesitan atención`}.
          </div>
        </div>
        <div className="alerts-summary">
          {crit > 0 && <><span className="count" style={{ color: "var(--danger)" }}>{crit} crítica</span> · </>}
          {high > 0 && <><span className="count">{high} importante{high > 1 ? "s" : ""}</span>{med > 0 ? " · " : ""}</>}
          {med > 0 && <span className="count">{med} leve{med > 1 ? "s" : ""}</span>}
        </div>
      </div>
      <article className="card alerts-card">
        {alerts.map((a, i) => (
          <div key={i} className={`alert alert-${a.severity} ${a.tag === "under" ? "alert-under" : ""}`}>
            <div className="alert-marker" />
            <div className="alert-body">
              <div className="alert-head">
                <span className="alert-icons"><ChannelLogo channelKey={a.channelKey} size={14} /></span>
                <span className="alert-product">{a.productLabel}</span>
                <span className="alert-channel">{a.channelLabel}</span>
                <span className={`alert-tag ${a.tag}`}><span className="dot" />{a.title}</span>
              </div>
              <div className="alert-msg" dangerouslySetInnerHTML={{ __html: a.msg }} />
              <div className="alert-rec">{a.rec}</div>
            </div>
          </div>
        ))}
      </article>
    </section>
  );
}

/* ===================== PRODUCTS ===================== */
function ProductsSection({ md, openCampaigns, setOpenCampaigns }: { md: B.MonthData; openCampaigns: Record<string, boolean>; setOpenCampaigns: (f: any) => void; }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">Detalle por producto</h2>
          <div className="section-desc">{md.isCurrent ? "Inversiones y Rentas — gasto en Meta Ads + Google Ads." : `Distribución del gasto en ${B.monthDisplay(md)} (mes cerrado).`}</div>
        </div>
      </div>
      <div className="product-grid">
        <ProductCard pk="inversiones" md={md} openCampaigns={openCampaigns} setOpenCampaigns={setOpenCampaigns} />
        <ProductCard pk="rentas" md={md} openCampaigns={openCampaigns} setOpenCampaigns={setOpenCampaigns} />
      </div>
    </section>
  );
}

function ProductCard({ pk, md, openCampaigns, setOpenCampaigns }: { pk: string; md: B.MonthData; openCampaigns: Record<string, boolean>; setOpenCampaigns: (f: any) => void; }) {
  const p = md.products?.[pk];
  if (!p) return null;
  const isCur = md.isCurrent;
  const meta = pk === "inversiones" ? { name: "Inversiones", sub: "Landing inversión" } : { name: "Rentas", sub: "Corretaje + experimento" };
  const overall = B.chStatus(p.pct_used || 0, isCur ? md.pctMonth : 100);
  const totalProj = (p.channels?.facebook?._proj || 0) + (p.channels?.google?._proj || 0);
  const allCamps = Object.entries(p.channels || {}).flatMap(([ck, cv]: any) =>
    (cv.campaigns || []).map((c: any) => ({ ...c, channel: ck })),
  ).sort((a: any, b: any) => (b.spend || 0) - (a.spend || 0));
  const isOpen = !!openCampaigns[pk];

  return (
    <article className="card product-card">
      <header className="product-head">
        <div>
          <div className="product-name">{meta.name}</div>
          <div className="product-name-sub">{meta.sub}</div>
        </div>
        <div className="product-amt">
          <div className="product-amt-big"><span className="cur">S/</span>{B.fmt(p.mtd, 0)}</div>
          <div className="product-amt-sm">de {B.sl(p.budget, 0)} · {B.pct(p.pct_used, 1)}</div>
        </div>
      </header>

      {Object.entries(p.channels || {}).map(([ck, cvAny]: any) => {
        const cv = cvAny;
        const st = B.chStatus(cv.pct_used || 0, isCur ? md.pctMonth : 100);
        const fillW = Math.min(cv.pct_used || 0, 100);
        const dailyLine = isCur ? `${B.sl(cv._daily, 0)}/día · proy ${B.sl(cv._proj, 0)}` : `promedio ${B.sl(cv._daily, 0)}/día`;
        return (
          <div className="channel" key={ck}>
            <div className="channel-name">
              <span className="channel-logo"><ChannelLogo channelKey={ck} /></span>
              {ck === "facebook" ? "Meta" : "Google"}
            </div>
            <div className="channel-bar">
              <div className={`fill ${st.bar}`} style={{ width: `${fillW}%` }} />
              {isCur && <div className="marker" style={{ left: `${Math.min(md.pctMonth, 99)}%` }} />}
            </div>
            <div className="channel-stats">
              <div className="channel-pct">{B.pct(cv.pct_used, 1)}</div>
              <div className="channel-sub">{B.sl(cv.mtd, 0)} de {B.sl(cv.budget, 0)}</div>
              <div className="channel-sub channel-sub-rate">{dailyLine}</div>
            </div>
          </div>
        );
      })}

      <div className="product-footer">
        <span className={`pill pill-${overall.tag}`}><span className="dot" />{overall.word}</span>
        <span style={{ color: "var(--muted-2)" }}>{isCur ? `proyecta ${B.sl(totalProj, 0)}` : `total ${B.sl(p.mtd, 0)}`}</span>
        {allCamps.length > 0 && isCur && (
          <button className={`toggle-link ${isOpen ? "open" : ""}`} onClick={() => setOpenCampaigns((s: any) => ({ ...s, [pk]: !s[pk] }))}>
            <span>{isOpen ? "Ocultar campañas" : "Ver campañas"}</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        )}
      </div>

      {allCamps.length > 0 && isCur && (
        <div className={`campaigns ${isOpen ? "open" : ""}`}>
          {allCamps.slice(0, 8).map((c: any, i: number) => (
            <div className="campaign" key={i}>
              <div className="campaign-name"><span className="campaign-chip"><ChannelLogo channelKey={c.channel} size={14} /></span>{c.name || c.id || "—"}</div>
              <div className="campaign-spend">{B.sl(c.spend, 0)}</div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/* ===================== HISTORY ===================== */
function HistorySection({ data, budget, onPick }: { data: any; budget: number; onPick: (k: string) => void; }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-title">Histórico mensual</h2>
          <div className="section-desc">Cómo fue cada mes vs el tope referencial {B.sl(budget, 0)}. Click en un mes para verlo arriba.</div>
        </div>
      </div>
      <article className="card history">
        <table>
          <thead>
            <tr>
              <th style={{ width: "14%" }}>Mes</th>
              <th style={{ width: "10%" }}><span className="grp">Inversiones</span>Meta</th>
              <th style={{ width: "10%" }}>Google</th>
              <th style={{ width: "10%" }}><span className="grp">Rentas</span>Meta</th>
              <th style={{ width: "10%" }}>Google</th>
              <th style={{ width: "12%" }}>Total</th>
              <th className="verdict-cell">vs Tope</th>
            </tr>
          </thead>
          <tbody>
            {(data?.historical_months || []).map((m: any) => {
              const inv = m.inversiones || {};
              const ren = m.rentas || {};
              const p = m.pct_vs_budget || 0;
              const v = B.histVerdict(p, !!m.is_partial);
              const fillCls = v.tag === "over" ? "over" : v.tag === "warn" ? "warn" : v.tag === "low" ? "partial" : "ok";
              return (
                <tr key={m.month} className={m.is_current ? "current" : ""} style={{ cursor: "pointer" }} onClick={() => onPick(m.month)}>
                  <td>{m.label || m.month}<small>{m.days_counted || m.days_in_month} / {m.days_in_month} días</small></td>
                  <td>{B.sl(inv.facebook, 0)}</td>
                  <td>{B.sl(inv.google, 0)}</td>
                  <td>{B.sl(ren.facebook, 0)}</td>
                  <td>{B.sl(ren.google, 0)}</td>
                  <td className="total">{B.sl(m.total_spend, 0)}</td>
                  <td className="verdict-cell">
                    <div className="mini-bar"><div className={`fill ${fillCls}`} style={{ width: `${Math.min(p, 130)}%` }} /><div className="target" /></div>
                    <div className="verdict-row">
                      <span className={`pill pill-${v.tag === "low" ? "low" : v.tag === "over" ? "over" : v.tag === "warn" ? "warn" : "ok"}`}>{v.word}</span>
                      <span className="pct" style={{ color: p > 100 ? "var(--danger)" : "var(--text)" }}>{B.pctI(p)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </article>
    </section>
  );
}
