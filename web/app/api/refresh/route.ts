import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
// El ETL puede tardar ~15-30s; damos margen.
export const maxDuration = 60;

export async function POST() {
  const etlUrl = process.env.ETL_URL;
  const secret = process.env.ETL_TRIGGER_SECRET;

  if (!etlUrl) {
    return NextResponse.json(
      { ok: false, error: "ETL_URL no configurada" },
      { status: 500 },
    );
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-Trigger-Secret"] = secret;

    const r = await fetch(`${etlUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers,
    });
    const body = await r.json().catch(() => ({}));

    if (!r.ok || !body.ok) {
      return NextResponse.json(
        { ok: false, error: body.error || `ETL respondió ${r.status}`, detail: body },
        { status: 502 },
      );
    }

    // Re-leer el snapshot recién guardado por el ETL.
    const snap = await prisma.snapshot.findFirst({
      where: { kind: "budget" },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      ok: true,
      elapsed_s: body.elapsed_s,
      generatedAt: snap?.generatedAt ?? null,
      data: snap?.payload ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
