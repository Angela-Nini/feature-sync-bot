import { request } from "undici";
import { assertFeishuApiConfig, config } from "./config.js";

type TenantTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getTenantAccessToken(): Promise<string> {
  assertFeishuApiConfig();

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const response = await request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: config.LARK_APP_ID,
      app_secret: config.LARK_APP_SECRET
    })
  });

  const data = await response.body.json() as TenantTokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg ?? data.code}`);
  }

  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + ((data.expire ?? 7200) * 1000)
  };

  return cachedToken.token;
}

export async function replyToMessage(messageId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken();
  const response = await request(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });

  const data = await response.body.json() as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`Failed to reply message: ${data.msg ?? data.code}`);
  }
}

export async function sendTextToChat(chatId: string, text: string): Promise<void> {
  const token = await getTenantAccessToken();
  const response = await request("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });

  const data = await response.body.json() as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`Failed to send chat message: ${data.msg ?? data.code}`);
  }
}
