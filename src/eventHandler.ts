import crypto from "node:crypto";
import { assertFeishuEventConfig, config } from "./config.js";
import { generateDraftBlocks, renderDraftMessage } from "./draftGenerator.js";
import { parseFeatureName, parseConfirmationCode } from "./featureParser.js";
import { completeJob, findPendingJob, saveJob } from "./jobStore.js";
import { replyToMessage } from "./larkClient.js";
import { readFeatureAvailability } from "./matrixReader.js";
import { updateRelatedDocs } from "./docUpdater.js";
import type { PendingJob } from "./types.js";

type MessageEvent = {
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: {
      message_id: string;
      chat_id: string;
      chat_type?: string;
      message_type: string;
      content: string;
    };
  };
  chat_id?: string;
  content?: string;
  message_id?: string;
  message_type?: string;
  sender_id?: string;
  type?: string;
};

type NormalizedMessage = {
  messageId: string;
  chatId: string;
  messageType: string;
  content: string;
  userId: string;
};

export async function handleFeishuEvent(body: unknown): Promise<Record<string, unknown>> {
  const payload = body as Record<string, unknown>;

  if (payload.type === "url_verification") {
    assertFeishuEventConfig();
    if (payload.token !== config.LARK_VERIFICATION_TOKEN) {
      throw new Error("Invalid verification token");
    }
    return { challenge: payload.challenge };
  }

  if (payload.encrypt) {
    throw new Error("Encrypted events are not implemented yet. Disable encryption or wire LARK_ENCRYPT_KEY decryption.");
  }

  if (payload.header && typeof payload.header === "object") {
    const header = payload.header as Record<string, unknown>;
    assertFeishuEventConfig();
    if (header.token && header.token !== config.LARK_VERIFICATION_TOKEN) {
      throw new Error("Invalid event token");
    }
  }

  await handleMessageEvent(payload as MessageEvent);
  return {};
}

async function handleMessageEvent(payload: MessageEvent): Promise<void> {
  const message = normalizeMessageEvent(payload);
  if (!message) return;
  if (message.messageType !== "text") return;

  const text = parseTextContent(message.content);
  const confirmationCode = parseConfirmationCode(text);

  if (confirmationCode) {
    const job = await findPendingJob(message.chatId, message.userId);
    if (!job) return;
    if (job.confirmationCode !== confirmationCode) {
      await replyToMessage(message.messageId, `确认码不匹配。请回复 ok ${job.confirmationCode} 来确认 ${job.feature} 的写入。`);
      return;
    }

    const result = await updateRelatedDocs(job.targetDocs, job.draftBlocks);
    await completeJob(job.jobId);

    const updated = result.updated.map((doc) => `- ${doc.title}`).join("\n") || "- None";
    const failed = result.failed.length > 0
      ? `\n\nFailed:\n${result.failed.map((item) => `- ${item.doc.title}: ${item.reason}`).join("\n")}`
      : "";

    await replyToMessage(message.messageId, `已完成 ${job.feature} 功能支持情况同步。\n\nUpdated docs:\n${updated}${failed}`);
    return;
  }

  if (/^(ok|okay|确认|yes|confirm)$/i.test(text.trim())) {
    const job = await findPendingJob(message.chatId, message.userId);
    if (job) {
      await replyToMessage(message.messageId, `请回复 ok ${job.confirmationCode} 来确认 ${job.feature} 的写入。`);
    }
    return;
  }

  const featureName = parseFeatureName(text);
  if (!featureName) return;

  const feature = await readFeatureAvailability(featureName);
  if (!feature) {
    await replyToMessage(message.messageId, `我没有在 Source of truth 中找到 “${featureName}”。请检查功能名称。`);
    return;
  }

  const draftBlocks = generateDraftBlocks(feature);
  const targetDocTitles = feature.relatedDocs.map((doc) => doc.title);
  const jobId = crypto.randomUUID();
  const jobConfirmationCode = createConfirmationCode(jobId);
  const reply = renderDraftMessage(feature.feature, draftBlocks, targetDocTitles, jobConfirmationCode);

  const job: PendingJob = {
    jobId,
    chatId: message.chatId,
    triggerUserId: message.userId,
    feature: feature.feature,
    confirmationCode: jobConfirmationCode,
    targetDocs: feature.relatedDocs,
    draftBlocks,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  await saveJob(job);
  await replyToMessage(message.messageId, reply);
}

function createConfirmationCode(jobId: string): string {
  return jobId.replace(/-/g, "").slice(0, 6).toUpperCase();
}

function normalizeMessageEvent(payload: MessageEvent): NormalizedMessage | undefined {
  const nestedMessage = payload.event?.message;
  const nestedUserId = payload.event?.sender?.sender_id?.open_id;
  if (nestedMessage && nestedUserId) {
    return {
      messageId: nestedMessage.message_id,
      chatId: nestedMessage.chat_id,
      messageType: nestedMessage.message_type,
      content: nestedMessage.content,
      userId: nestedUserId
    };
  }

  if (payload.message_id && payload.chat_id && payload.message_type && payload.content && payload.sender_id) {
    return {
      messageId: payload.message_id,
      chatId: payload.chat_id,
      messageType: payload.message_type,
      content: payload.content,
      userId: payload.sender_id
    };
  }

  return undefined;
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return content;
  }
}
