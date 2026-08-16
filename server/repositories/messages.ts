import crypto from "node:crypto";
import type { ChatMessage, HermesMessageInput } from "../../shared/types.js";
import { database } from "../database/connection.js";

export function insertChatMessages(inputs: HermesMessageInput[]): ChatMessage[] {
  const now = new Date().toISOString();
  const inserted: ChatMessage[] = [];
  const statement = database().prepare(`
    INSERT OR IGNORE INTO chat_messages (id, externalId, source, sender, content, messageAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const input of inputs) {
    const source = (input.source || "hermes").slice(0, 40);
    const content = input.content.trim();
    if (!content) continue;
    const messageAt = input.messageAt ? new Date(input.messageAt).toISOString() : now;
    const externalId = input.externalId
      || crypto.createHash("sha256").update(`${source}:${input.sender}:${messageAt}:${content}`).digest("hex");
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      externalId,
      source,
      sender: input.sender.trim().slice(0, 80) || "unknown",
      content: content.slice(0, 20_000),
      messageAt,
      createdAt: now
    };
    const result = statement.run(
      message.id, message.externalId, message.source, message.sender, message.content, message.messageAt, message.createdAt
    );
    if (Number(result.changes) > 0) inserted.push(message);
  }
  return inserted;
}
