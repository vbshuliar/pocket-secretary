import { NextRequest, NextResponse } from "next/server";
import { buildGoogleAuthUrl, generateOpaqueState } from "@/src/lib/google-oauth";
import { setJson } from "@/src/lib/upstash";
import { getConnectTokenRecord } from "@/src/bot/process-update";
import type { OAuthStateRecord } from "@/src/types";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { error: "Missing connect token." },
      { status: 400 },
    );
  }

  const connectRecord = await getConnectTokenRecord(token);
  if (!connectRecord) {
    return NextResponse.json(
      { error: "Connect token is missing or expired." },
      { status: 400 },
    );
  }

  const state = generateOpaqueState();
  await setJson(
    `oauth-state:${state}`,
    {
      connectToken: token,
      telegramUserId: connectRecord.telegramUserId,
      chatId: connectRecord.chatId,
    } satisfies OAuthStateRecord,
    60 * 10,
  );

  return NextResponse.redirect(buildGoogleAuthUrl(state));
}
