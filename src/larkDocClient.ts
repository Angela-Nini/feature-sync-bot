import { request } from "undici";
import { getTenantAccessToken } from "./larkClient.js";

type WikiNodeResponse = {
  code: number;
  msg?: string;
  data?: {
    node?: {
      obj_token?: string;
      obj_type?: string;
      title?: string;
    };
  };
};

type RawContentResponse = {
  code: number;
  msg?: string;
  data?: {
    content?: string;
  };
};

export async function fetchFeishuDocContent(docUrlOrToken: string): Promise<string> {
  const tokenInfo = parseFeishuDocToken(docUrlOrToken);
  const documentId = tokenInfo.kind === "wiki"
    ? await resolveWikiDocumentToken(tokenInfo.token)
    : tokenInfo.token;

  return fetchDocxRawContent(documentId);
}

function parseFeishuDocToken(input: string): { kind: "wiki" | "docx"; token: string } {
  const wikiMatch = input.match(/\/wiki\/([^/?#]+)/);
  if (wikiMatch?.[1]) return { kind: "wiki", token: wikiMatch[1] };

  const docxMatch = input.match(/\/docx\/([^/?#]+)/);
  if (docxMatch?.[1]) return { kind: "docx", token: docxMatch[1] };

  return { kind: "wiki", token: input };
}

async function resolveWikiDocumentToken(wikiToken: string): Promise<string> {
  const token = await getTenantAccessToken();
  const response = await request(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  const data = await response.body.json() as WikiNodeResponse;
  const objToken = data.data?.node?.obj_token;
  if (data.code !== 0 || !objToken) {
    throw new Error(`Failed to resolve wiki node: ${data.msg ?? data.code}`);
  }

  return objToken;
}

async function fetchDocxRawContent(documentId: string): Promise<string> {
  const token = await getTenantAccessToken();
  const response = await request(`https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  const data = await response.body.json() as RawContentResponse;
  const content = data.data?.content;
  if (data.code !== 0 || typeof content !== "string") {
    throw new Error(`Failed to fetch docx raw content: ${data.msg ?? data.code}`);
  }

  return content;
}
