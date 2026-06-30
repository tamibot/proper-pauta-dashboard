import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Siempre dinámico: queremos el último snapshot, sin cache de Next.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snap = await prisma.snapshot.findFirst({
      where: { kind: "budget" },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      ok: true,
      generatedAt: snap?.generatedAt ?? null,
      data: snap?.payload ?? null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 200 con data:null para no romper el healthcheck mientras no haya snapshot/DB.
    return NextResponse.json({ ok: false, error: msg, data: null });
  }
}
