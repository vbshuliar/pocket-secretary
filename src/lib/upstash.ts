import { getUpstashKeyPrefix, getUpstashToken, getUpstashUrl } from "@/src/lib/env";

const BASE_URL = getUpstashUrl();
const TOKEN = getUpstashToken();

async function execute<T>(command: Array<string | number>): Promise<T | null> {
  const response = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Upstash request failed with status ${response.status}`);
  }

  const data = (await response.json()) as { result?: T; error?: string };
  if (data.error) {
    throw new Error(data.error);
  }

  return data.result ?? null;
}

export function prefixedKey(key: string): string {
  return `${getUpstashKeyPrefix()}:${key}`;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const result = await execute<string>(["GET", prefixedKey(key)]);
  return result ? (JSON.parse(result) as T) : null;
}

export async function setJson(
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const stringValue = JSON.stringify(value);
  const command = ttlSeconds
    ? ["SETEX", prefixedKey(key), ttlSeconds, stringValue]
    : ["SET", prefixedKey(key), stringValue];
  await execute(command);
}

export async function setString(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  const command = ttlSeconds
    ? ["SETEX", prefixedKey(key), ttlSeconds, value]
    : ["SET", prefixedKey(key), value];
  await execute(command);
}

export async function getString(key: string): Promise<string | null> {
  return execute<string>(["GET", prefixedKey(key)]);
}

export async function deleteKey(key: string): Promise<void> {
  await execute(["DEL", prefixedKey(key)]);
}

export async function addToSet(key: string, value: string): Promise<void> {
  await execute(["SADD", prefixedKey(key), value]);
}

export async function removeFromSet(key: string, value: string): Promise<void> {
  await execute(["SREM", prefixedKey(key), value]);
}

export async function getSetMembers(key: string): Promise<string[]> {
  return (await execute<string[]>(["SMEMBERS", prefixedKey(key)])) ?? [];
}

export async function hasSeenTelegramUpdate(updateId: number): Promise<boolean> {
  const key = `telegram:update:${updateId}`;
  const exists = await getString(key);
  if (exists) {
    return true;
  }

  await setString(key, "1", 60 * 60 * 24);
  return false;
}
