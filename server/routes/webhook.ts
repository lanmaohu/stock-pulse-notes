import { Router, type Request } from "express";
import type { HermesMessageInput, HermesWebhookInput } from "../../shared/types.js";
import { requireWebhook } from "../auth.js";
import { insertChatMessages } from "../repositories/messages.js";
import { HttpError } from "../http-error.js";

export const webhookRouter = Router();

function normalizeWebhookInput(body: HermesWebhookInput): HermesMessageInput[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.sender === "string" && typeof body.content === "string") {
    return [{ externalId: body.externalId, source: body.source, sender: body.sender, content: body.content, messageAt: body.messageAt }];
  }
  throw new HttpError(400, "Webhook body must include messages[] or a single sender/content message.", "INVALID_WEBHOOK_BODY");
}

webhookRouter.post("/webhooks/hermes/messages", requireWebhook, (req: Request<unknown, unknown, HermesWebhookInput>, res) => {
  const inserted = insertChatMessages(normalizeWebhookInput(req.body));
  res.status(201).json({ inserted: inserted.length, messages: inserted });
});
