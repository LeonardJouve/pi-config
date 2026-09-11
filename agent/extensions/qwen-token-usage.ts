import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "qwen-token-usage";
const REFRESH_MS = 60_000;
const ORIGIN = "https://home.qwencloud.com";
const USER_INFO_URL = `${ORIGIN}/tool/user/info.json`;
const API_NAME = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const API_URL = new URL("https://cs-data.qwencloud.com/data/api.json");
API_URL.search = new URLSearchParams({
  product: "sfm_bailian",
  action: "IntlBroadScopeAspnGateway",
  api: API_NAME,
}).toString();

export interface QwenUsage {
  weeklyPercent: number;
}

export function parseUsage(payload: unknown): QwenUsage {
  const body = payload as any;
  const usage = body?.data?.DataV2?.data?.data;
  const weeklyValue = usage?.per1WeekPercentage;
  if ((typeof weeklyValue !== "number" && typeof weeklyValue !== "string") || String(weeklyValue).trim() === "") {
    throw new Error("Invalid Qwen usage response");
  }
  const weekly = Number(weeklyValue);
  if (!Number.isFinite(weekly)) {
    throw new Error("Invalid Qwen usage response");
  }
  return {
    weeklyPercent: Number((weekly * 100).toFixed(12)),
  };
}

export function formatUsage(usage: QwenUsage, theme: ExtensionContext["ui"]["theme"]): string {
  const percent = Math.round(usage.weeklyPercent);
  const text = `${percent}%`;
  const label = theme.getColorMode() === "truecolor"
    ? "\x1b[38;2;82;41;230mqwen-token-plan\x1b[39m"
    : "\x1b[38;5;56mqwen-token-plan\x1b[39m";
  const colored = percent >= 90
    ? theme.fg("error", text)
    : percent >= 75
      ? `\x1b[38;5;208m${text}\x1b[39m`
      : percent >= 50
        ? theme.fg("warning", text)
        : theme.fg("success", text);
  return `${label} weekly quota ${colored}`;
}

export function buildUsageRequest(secToken: string, cookie: string): { url: string; init: RequestInit } {
  const params = JSON.stringify({
    Api: API_NAME,
    Data: {
      cornerstoneParam: {
        domain: "home.qwencloud.com",
        consoleSite: "QWENCLOUD",
        console: "ONE_CONSOLE",
        xsp_lang: "en-US",
        protocol: "V2",
        productCode: "p_efm",
      },
    },
    V: "1.0",
  });
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: "IntlBroadScopeAspnGateway",
    sec_token: secToken,
    region: "ap-southeast-1",
    params,
  });
  return {
    url: API_URL.toString(),
    init: {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/billing/subscription/token-plan-individual`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    },
  };
}

async function fetchSecurityToken(cookie: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(USER_INFO_URL, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: cookie,
        Referer: `${ORIGIN}/`,
      },
    });
  } catch {
    throw new Error("Qwen: network error");
  }
  if (!response.ok) throw new Error(`Qwen: user info HTTP ${response.status}`);
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Qwen: invalid user info response");
  }
  if (!payload?.data || typeof payload.data !== "object") {
    throw new Error("Qwen: invalid user info response");
  }
  const token = payload?.data?.secToken ?? payload?.data?.sec_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Qwen: token missing");
  }
  return token;
}

async function fetchUsage(cookie: string): Promise<QwenUsage> {
  const request = buildUsageRequest(await fetchSecurityToken(cookie), cookie);
  let response: Response;
  try {
    response = await fetch(request.url, request.init);
  } catch {
    throw new Error("Qwen: network error");
  }
  if (!response.ok) throw new Error(`Qwen: usage HTTP ${response.status}`);
  try {
    return parseUsage(await response.json());
  } catch {
    throw new Error("Qwen: invalid usage response");
  }
}

export default function qwenTokenUsage(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let session = 0;

  async function refresh(ctx: ExtensionContext, currentSession: number): Promise<void> {
    if (refreshing) return;
    const cookie = process.env.QWEN_COOKIE?.trim();
    if (!cookie) {
      ctx.ui.setStatus(STATUS_ID, "Qwen: auth required");
      return;
    }
    refreshing = true;
    try {
      const status = formatUsage(await fetchUsage(cookie), ctx.ui.theme);
      if (currentSession === session) ctx.ui.setStatus(STATUS_ID, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = /^Qwen: (?:user info|usage) HTTP \d{3}$/.test(message)
        || [
          "Qwen: token missing",
          "Qwen: invalid user info response",
          "Qwen: invalid usage response",
          "Qwen: network error",
        ].includes(message)
        ? message
        : "Qwen: network error";
      if (currentSession === session) ctx.ui.setStatus(STATUS_ID, status);
    } finally {
      refreshing = false;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const currentSession = ++session;
    void refresh(ctx, currentSession);
    timer = setInterval(() => void refresh(ctx, currentSession), REFRESH_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session++;
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
