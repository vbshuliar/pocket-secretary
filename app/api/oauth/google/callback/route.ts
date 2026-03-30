import { NextRequest, NextResponse } from "next/server";
import { consumeConnectToken } from "@/src/bot/process-update";
import { exchangeGoogleCode } from "@/src/lib/google-oauth";
import { getGoogleEmail, storeGoogleTokens } from "@/src/lib/google-workspace";
import { sendTelegramMessage } from "@/src/lib/telegram-api";
import { deleteKey, getJson } from "@/src/lib/upstash";
import type { OAuthStateRecord } from "@/src/types";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/connect?status=error&reason=${encodeURIComponent(error)}`, request.url),
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/connect?status=error", request.url));
  }

  const oauthState = await getJson<OAuthStateRecord>(`oauth-state:${state}`);
  if (!oauthState) {
    return NextResponse.redirect(
      new URL("/connect?status=expired", request.url),
    );
  }

  await deleteKey(`oauth-state:${state}`);
  const connectRecord = await consumeConnectToken(oauthState.connectToken);
  if (!connectRecord) {
    return NextResponse.redirect(
      new URL("/connect?status=expired", request.url),
    );
  }

  const tokenRecord = await exchangeGoogleCode(code);
  tokenRecord.email = await getGoogleEmail(tokenRecord.accessToken);
  await storeGoogleTokens(connectRecord.telegramUserId, tokenRecord);
  await sendTelegramMessage(
    connectRecord.chatId,
    tokenRecord.email
      ? `Google account connected: ${tokenRecord.email}`
      : "Google account connected. You can now send requests.",
  );

  return NextResponse.redirect(
    new URL(
      `/connect?status=connected&email=${encodeURIComponent(tokenRecord.email ?? "")}`,
      request.url,
    ),
  );
}
