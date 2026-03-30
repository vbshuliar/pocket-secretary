import { NextResponse } from "next/server";
import { checkInboxNotifications } from "@/src/lib/email-notifier";

export async function POST() {
  try {
    const result = await checkInboxNotifications();
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
