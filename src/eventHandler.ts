import { prepareRegionJob, confirmRegionJob } from "./regionConfirmation.js";
import { parseRegionCommand } from "./regionWorkflow.js";
import crypto from "node:crypto";
import { assertFeishuEventConfig, config } from "./config.js";
import { generateDraftBlocks, renderDraftMessage } from "./draftGenerator.js";
import { parseFeatureName, parseConfirmationCode } from "./featureParser.js";
import { completeJob, findPendingJob, saveJob } from "./jobStore.js";
import { replyToMessage } from "./larkClient.js";
import { readFeatureAvailability } from "./matrixReader.js";
import { updateRelatedDocs } from "./docUpdater.js";
import type { PendingJob } from "./types.js";

const seenMessages = new Map<string, number>();

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
    if (header.token !== config.LARK_VERIFICATION_TOKEN) {
      throw new Error("Invalid event token");
    }
  }

  if (!payload.header || typeof payload.header !== "object") {
    throw new Error("Missing Feishu event header");
  }
  const messageId = (payload as MessageEvent).event?.message?.message_id;
  if (!messageId || seenMessages.has(messageId)) return {};
  seenMessages.set(messageId, Date.now());
  for (const [id, time] of seenMessages) {
    if (Date.now() - time > 24 * 60 * 60 * 1000) seenMessages.delete(id);
  }
  // Acknowledge immediately; Feishu retries callbacks that exceed three seconds.
  setImmediate(() => {
    void handleMessageEvent(payload as MessageEvent).catch(error => {
      console.error("Feishu message processing failed:", error instanceof Error ? error.message : String(error));
    });
  });
  return {};
}

async function handleMessageEvent(payload: MessageEvent): Promise<void> {
  const message = normalizeMessageEvent(payload);
  if (!message) return;
  if (message.messageType !== "text") return;

  const text = parseTextContent(message.content);
  const regionFeature = parseRegionCommand(text);
  if (regionFeature) {
    try {
      await replyToMessage(message.messageId, `已收到，正在查询 ${regionFeature} 的 CMS 区域信息和相关文档，请稍候。我会先生成预览，只有你回复确认码后才会写入。`);
      const { message: preview } = await prepareRegionJob(regionFeature, message.chatId, message.userId);
      // Keep each reply below the text message size limit.
      for (let offset = 0; offset < preview.length; offset += 6000) {
        await replyToMessage(message.messageId, preview.slice(offset, offset + 6000));
      }
    } catch (error) {
      await replyToMessage(message.messageId, `Region 预览失败，未写入文档：${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  const confirmationCode = parseConfirmationCode(text);

  if (confirmationCode) {
    await replyToMessage(message.messageId, "已收到确认，正在校验数据和文档版本，请稍候。");
    const regionResult = await confirmRegionJob(confirmationCode, message.chatId, message.userId);
    if (regionResult !== null) {
      for (let offset = 0; offset < regionResult.length; offset += 6000) {
        await replyToMessage(message.messageId, regionResult.slice(offset, offset + 6000));
      }
      return;
    }
    const job = await findPendingJob(message.chatId, message.userId);
    if (!job) {
      await replyToMessage(message.messageId, "没有找到属于你和当前会话的有效确认码，请重新发送预览指令。");
      return;
    }
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

  await replyToMessage(message.messageId, `已收到，正在查询 ${featureName} 的功能支持情况和相关文档，请稍候。`);
  const feature = await readFeatureAvailability(featureName);
  if (!feature) {
    await replyToMessage(message.messageId, `我没有在 Source of truth 中找到 “${featureName}”。请检查功能名称。`);
    return;
  }

  const draftBlocks = generateDraftBlocks(feature);
  const targetDocTitles = feature.relatedDocs.map((doc) => doc.title);
  if (targetDocTitles.length === 0) {
    const reply = renderDraftMessage(feature.feature, draftBlocks, targetDocTitles);
    await replyToMessage(message.messageId, reply);
    return;
  }

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
