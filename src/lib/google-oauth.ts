import { randomUUID } from "node:crypto";
import { getGoogleClientId, getGoogleClientSecret, getGoogleOAuthScopes, getGoogleRedirectUri } from "@/src/lib/env";
import type { GoogleTokenRecord } from "@/src/types";

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: getGoogleRedirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: getGoogleOAuthScopes().join(" "),
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function generateOpaqueState(): string {
  return randomUUID();
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenRecord> {
  const params = new URLSearchParams({
    code,
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    redirect_uri: getGoogleRedirectUri(),
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
    scope: json.scope ?? null,
    email: null,
  };
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<Pick<GoogleTokenRecord, "accessToken" | "expiresAt" | "scope">> {
  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Google token refresh failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : null,
    scope: json.scope ?? null,
  };
}
