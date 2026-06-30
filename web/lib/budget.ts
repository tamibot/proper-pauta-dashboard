// Lógica pura del dashboard de presupuesto — portada del mockup vanilla.
// Sin DOM: solo cálculo. Los componentes React la consumen.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const MES_LARGO = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/* ---------- formatters ---------- */
export function fmt(n: number | null | undefined, dec = 0): string {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n).toFixed(dec);
  const [i, f] = v.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}
export const sl = (n: number | null | undefined, dec = 0) =>
  n == null || isNaN(n as number) ? "—" : `S/ ${fmt(n, dec)}`;
export const pct = (n: number | null | undefined, dec = 1) =>
  n == null || isNaN(n as number) ? "—" : `${Number(n).toFixed(dec)}%`;
export const pctI = (n: number | null | undefined) =>
  n == null || isNaN(n as number) ? "—" : `${Math.round(Number(n))}%`;

/* ---------- status logic ---------- */
export function chStatus(used: number, monthPct: number) {
  if (used > 100) return { tag: "over", word: "pasado", bar: "over" };
  if (used > monthPct + 10) return { tag: "warn", word: "acelerado", bar: "warn" };
  if (used < monthPct - 25) return { tag: "low", word: "lento", bar: "" };
  return { tag: "ok", word: "en línea", bar: "" };
}
export function histVerdict(p: number, partial: boolean) {
  if (partial) return { tag: "low", word: "en curso" };
  if (p > 105) return { tag: "over", word: "pasó el tope" };
  if (p > 95) return { tag: "warn", word: "al filo" };
  if (p < 60) return { tag: "warn", word: "muy bajo" };
  return { tag: "ok", word: "dentro" };
}

/* ---------- types ---------- */
export interface MonthOption {
  key: string;
  label: string;
  isCurrent: boolean;
  isPartial: boolean;
  total: number;
  pct: number;
  daysIn: number;
  daysCounted: number;
  raw: any;
}
export interface MonthData {
  key: string;
  isCurrent: boolean;
  isPartial: boolean;
  daysIn: number;
  daysE: number;
  pctMonth: number;
  total: any;
  products: Record<string, any>;
  metaMtd: number;
  googleMtd: number;
  metaDaysWithSpend: number;
  googleDaysWithSpend: number;
  metaDaily: number;
  googleDaily: number;
  daysRem: number;
  metaProj: number;
  googleProj: number;
  totalProj: number;
}

/* ---------- months list ---------- */
export function buildMonthsList(data: any): MonthOption[] {
  const hm = (data?.historical_months || []).slice();
  hm.sort((a: any, b: any) => (b.month || "").localeCompare(a.month || ""));
  return hm.map((m: any) => ({
    key: m.month,
    label: m.label || m.month,
    isCurrent: !!m.is_current,
    isPartial: !!m.is_partial,
    total: m.total_spend || 0,
    pct: m.pct_vs_budget || 0,
    daysIn: m.days_in_month || 31,
    daysCounted: m.days_counted || m.days_in_month || 31,
    raw: m,
  }));
}

export function monthDisplay(m: { key?: string; label?: string } | null): string {
  if (!m || !m.key) return m?.label || "—";
  const [y, mo] = m.key.split("-");
  return `${MES_LARGO[parseInt(mo, 10) - 1]} ${y}`;
}

/* ---------- per-month data (current + past) ---------- */
export function getMonthData(monthKey: string, data: any): MonthData | null {
  const hm = (data?.historical_months || []).find((m: any) => m.month === monthKey);
  const isCurrent = !!hm?.is_current;
  const isPartial = !!hm?.is_partial;
  let md: any;

  if (isCurrent && data.budget_by_product) {
    const bbp = data.budget_by_product;
    md = {
      key: monthKey,
      isCurrent: true,
      isPartial: !!bbp.pct_month_elapsed && bbp.pct_month_elapsed < 100,
      daysIn: bbp.days_in_month || 31,
      daysE: bbp.days_elapsed || 0,
      pctMonth: bbp.pct_month_elapsed || 0,
      total: bbp.total || {},
      products: JSON.parse(JSON.stringify(bbp.products || {})),
    };
    return enrichWithPlatformMetrics(md, data);
  }
  if (!hm) return null;

  const bbpRef = data.budget_by_product || {};
  const refTotal = bbpRef.total || {};
  const refProducts = bbpRef.products || {};
  const totalBudget = refTotal.budget || hm.budget_referencial || 9300;
  const totalSpend = hm.total_spend || 0;
  const daysIn = hm.days_in_month || 31;
  const daysCounted = hm.days_counted || daysIn;
  const runRate = daysCounted > 0 ? totalSpend / daysCounted : 0;
  const remaining = totalBudget - totalSpend;

  const products: Record<string, any> = {};
  ["inversiones", "rentas"].forEach((pk) => {
    const histP = hm[pk] || {};
    const refP = refProducts[pk] || {};
    const refChan = refP.channels || {};
    const pBudget = refP.budget || 0;
    const channels: Record<string, any> = {};
    ["facebook", "google"].forEach((ck) => {
      const mtd = histP[ck] || 0;
      const cBudget = (refChan[ck] || {}).budget || 0;
      channels[ck] = {
        budget: cBudget,
        mtd,
        pct_used: cBudget > 0 ? (mtd / cBudget) * 100 : 0,
        projected_eom: mtd,
        run_rate_daily: daysCounted > 0 ? mtd / daysCounted : 0,
        campaigns: [],
      };
    });
    const pSpend = (histP.facebook || 0) + (histP.google || 0);
    products[pk] = {
      budget: pBudget,
      mtd: pSpend,
      pct_used: pBudget > 0 ? (pSpend / pBudget) * 100 : 0,
      channels,
    };
  });

  md = {
    key: monthKey,
    isCurrent: false,
    isPartial,
    daysIn,
    daysE: daysCounted,
    pctMonth: 100,
    total: {
      budget: totalBudget,
      mtd: totalSpend,
      pct_used: totalBudget > 0 ? (totalSpend / totalBudget) * 100 : 0,
      run_rate_daily: runRate,
      projected_eom: totalSpend,
      remaining_budget: remaining,
    },
    products,
  };
  return enrichWithPlatformMetrics(md, data);
}

export function enrichWithPlatformMetrics(md: any, data: any): MonthData {
  const monthPrefix = md.key + "-";
  const monthDays = (data?.days || []).filter((d: any) =>
    (d.fecha || "").startsWith(monthPrefix),
  );

  md.metaDaysWithSpend = Math.max(
    monthDays.filter((d: any) => (d.meta_spend || 0) > 0).length, 1,
  );
  md.googleDaysWithSpend = Math.max(
    monthDays.filter((d: any) => (d.gads_spend || 0) > 0).length, 1,
  );

  md.metaMtd =
    (md.products?.inversiones?.channels?.facebook?.mtd || 0) +
    (md.products?.rentas?.channels?.facebook?.mtd || 0);
  md.googleMtd =
    (md.products?.inversiones?.channels?.google?.mtd || 0) +
    (md.products?.rentas?.channels?.google?.mtd || 0);

  md.metaDaily = md.metaMtd / md.metaDaysWithSpend;
  md.googleDaily = md.googleMtd / md.googleDaysWithSpend;
  md.daysRem = Math.max(md.daysIn - md.daysE, 0);

  (["inversiones", "rentas"] as const).forEach((pk) => {
    const p = md.products?.[pk];
    if (!p?.channels) return;
    if (p.channels.facebook) {
      const cMtd = p.channels.facebook.mtd || 0;
      const cDaily = cMtd / md.metaDaysWithSpend;
      p.channels.facebook._daily = cDaily;
      p.channels.facebook._proj = md.isCurrent ? cMtd + cDaily * md.daysRem : cMtd;
    }
    if (p.channels.google) {
      const cMtd = p.channels.google.mtd || 0;
      const cDaily = cMtd / md.googleDaysWithSpend;
      p.channels.google._daily = cDaily;
      p.channels.google._proj = md.isCurrent ? cMtd + cDaily * md.daysRem : cMtd;
    }
  });

  md.metaProj = md.isCurrent ? md.metaMtd + md.metaDaily * md.daysRem : md.metaMtd;
  md.googleProj = md.isCurrent ? md.googleMtd + md.googleDaily * md.daysRem : md.googleMtd;
  md.totalProj = md.metaProj + md.googleProj;
  return md as MonthData;
}

/* ---------- alerts ---------- */
export interface Alert {
  severity: "critical" | "high" | "medium";
  tag: "over" | "warn" | "under";
  productLabel: string;
  channelLabel: string;
  channelKey: string;
  title: string;
  msg: string;
  rec: string;
}

export function getAlerts(md: MonthData): Alert[] {
  if (!md.isCurrent) return [];
  const alerts: Alert[] = [];
  const pctMonth = md.pctMonth || 0;
  const TH_OVER = 1.1;
  const TH_UNDER = 0.75;
  const TH_UNDER_HIGH = 0.5;

  (["inversiones", "rentas"] as const).forEach((pk) => {
    const p = md.products?.[pk];
    if (!p?.channels) return;
    Object.entries(p.channels).forEach(([ck, cvAny]) => {
      const cv = cvAny as any;
      const realPct = cv.pct_used || 0;
      const projPct = cv.budget > 0 ? (cv._proj / cv.budget) * 100 : 0;
      const ratio = pctMonth > 0 ? realPct / pctMonth : 1;
      const productLabel = pk === "inversiones" ? "Inversiones" : "Rentas";
      const channelLabel = ck === "facebook" ? "Meta" : "Google";
      const overshoot = cv._proj - cv.budget;
      const undershoot = cv.budget - cv._proj;

      if (realPct > 100) {
        alerts.push({
          severity: "critical", tag: "over", productLabel, channelLabel, channelKey: ck,
          title: "Tope superado",
          msg: `Llevás <strong>${sl(cv.mtd, 0)}</strong> de ${sl(cv.budget, 0)} (${pct(realPct, 1)}). Excediste el tope por <strong>${sl(cv.mtd - cv.budget, 0)}</strong>.`,
          rec: `Pausá la campaña o bajá los daily caps en ${channelLabel} ya.`,
        });
        return;
      }
      if (projPct > 110) {
        alerts.push({
          severity: "high", tag: "over", productLabel, channelLabel, channelKey: ck,
          title: "Sobre-gasto proyectado",
          msg: `Llevás <strong>${pct(realPct, 1)}</strong> con ${pct(pctMonth, 1)} del mes corrido. Si seguís así, cerrás en <strong>${sl(cv._proj, 0)}</strong> → <strong>${sl(overshoot, 0)}</strong> sobre el tope.`,
          rec: `Bajá el daily budget ~${Math.round((overshoot / Math.max(cv._proj, 1)) * 100)}% en ${channelLabel} para llegar al tope.`,
        });
        return;
      }
      if (ratio > TH_OVER) {
        alerts.push({
          severity: "medium", tag: "warn", productLabel, channelLabel, channelKey: ck,
          title: "Acelerado",
          msg: `Llevás <strong>${pct(realPct, 1)}</strong>, esperado ${pct(pctMonth, 1)}. Proyectás cerrar en <strong>${sl(cv._proj, 0)}</strong>${overshoot > 0 ? ` → ${sl(overshoot, 0)} sobre tope` : ""}.`,
          rec: overshoot > 0
            ? `Vigilá los próximos días — si el ritmo sigue, cerrás levemente arriba.`
            : `Vas adelantado pero todavía dentro del tope. Sin acción necesaria.`,
        });
        return;
      }
      if (ratio < TH_UNDER_HIGH) {
        alerts.push({
          severity: "high", tag: "under", productLabel, channelLabel, channelKey: ck,
          title: "Muy subutilizado",
          msg: `Llevás solo <strong>${pct(realPct, 1)}</strong> cuando deberías ir en ${pct(pctMonth, 1)}. Proyectás cerrar en <strong>${sl(cv._proj, 0)}</strong> → <strong>${sl(undershoot, 0)}</strong> sin usar.`,
          rec: `Subí el daily budget en ${channelLabel} o reasigná los ${sl(undershoot, 0)} a otro canal con mejor performance.`,
        });
        return;
      }
      if (ratio < TH_UNDER) {
        alerts.push({
          severity: "medium", tag: "under", productLabel, channelLabel, channelKey: ck,
          title: "Bajo ritmo",
          msg: `Llevás <strong>${pct(realPct, 1)}</strong>, esperado ${pct(pctMonth, 1)}. Proyectás cerrar en <strong>${sl(cv._proj, 0)}</strong> → ${sl(undershoot, 0)} sin usar.`,
          rec: `Considerá subir el daily budget en ${channelLabel} si querés acercarte al tope.`,
        });
        return;
      }
    });
  });

  const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  alerts.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  return alerts;
}
