import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth";
import { getSessionUser } from "@/lib/auth-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Authentication must not block guest use when a database is temporarily unavailable.
    return NextResponse.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
