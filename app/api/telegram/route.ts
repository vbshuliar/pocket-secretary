import { NextRequest, NextResponse } from "next/server";
import { processTelegramUpdate } from "@/src/bot/process-update";
import type { TelegramUpdate } from "@/src/types";

export async function POST(request: NextRequest) {
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");

    if (secret && headerSecret !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const result = await processTelegramUpdate(update);

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "telegram",
  });
}
