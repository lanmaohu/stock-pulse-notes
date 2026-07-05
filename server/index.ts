import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { summarizeDate } from "./ai.js";
import {
  createNote,
  deleteNote,
  ensureDatabase,
  insertChatMessages,
  listChatMessages,
  listDailySummaries,
  listNotes,
  listResearchSuggestions,
  updateNote
} from "./db.js";
import { startSummaryScheduler } from "./scheduler.js";
import type {
  ChatMessagesResponse,
  DailySummariesResponse,
  HealthResponse,
  HermesMessageInput,
  HermesWebhookInput,
  LoginResponse,
  Note,
  NoteInput,
  NotesResponse,
  ResearchSuggestionsResponse
} from "../shared/types.js";

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const staticDir = path.join(process.cwd(), "dist");
const port = Number(process.env.PORT ?? 3000);
const tokenMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

function requireSecret(name: "NOTES_PASSWORD" | "SESSION_SECRET" | "WEBHOOK_TOKEN") {
  const value = process.env[name];
  if (!value || value.includes("change-this") || value.includes("replace-with")) {
    throw new HttpError(500, `${name} is not configured.`);
  }
  return value;
}

function signToken(payload: string) {
  const secret = requireSecret("SESSION_SECRET");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createToken() {
  const payload = Buffer.from(
    JSON.stringify({
      sub: "owner",
      exp: Date.now() + tokenMaxAgeMs
    })
  ).toString("base64url");
  return `${payload}.${signToken(payload)}`;
}

function verifyToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || signToken(payload) !== signature) {
    return false;
  }

  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof body.exp === "number" && body.exp > Date.now();
  } catch {
    return false;
  }
}

function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!verifyToken(token)) {
    throw new HttpError(401, "Unauthorized.");
  }
  next();
}

function webhookMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== requireSecret("WEBHOOK_TOKEN")) {
    throw new HttpError(401, "Unauthorized webhook.");
  }
  next();
}

function sanitizeInput(input: NoteInput) {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  const content = typeof input.content === "string" ? input.content.slice(0, 50000) : "";
  const pinned = typeof input.pinned === "boolean" ? input.pinned : false;
  const tags = Array.isArray(input.tags)
    ? input.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag: string) => tag.trim().replace(/\s+/g, " ").slice(0, 24))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  return {
    title: title || "未命名笔记",
    content,
    pinned,
    tags: Array.from(new Set(tags))
  };
}

function normalizeWebhookInput(body: HermesWebhookInput): HermesMessageInput[] {
  if (Array.isArray(body.messages)) {
    return body.messages;
  }
  if (typeof body.sender === "string" && typeof body.content === "string") {
    return [
      {
        externalId: body.externalId,
        source: body.source,
        sender: body.sender,
        content: body.content,
        messageAt: body.messageAt
      }
    ];
  }
  throw new HttpError(400, "Webhook body must include messages[] or a single sender/content message.");
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "Date must be YYYY-MM-DD.");
  }
}

app.get("/api/health", (_req, res: Response<HealthResponse>) => {
  res.json({ ok: true, service: "stockpulse", storage: "sqlite" });
});

app.post("/api/login", (req: Request<unknown, LoginResponse, { password?: string }>, res) => {
  const password = requireSecret("NOTES_PASSWORD");
  if (req.body.password !== password) {
    throw new HttpError(401, "密码不正确。");
  }
  res.json({ token: createToken() });
});

app.get("/api/notes", authMiddleware, (_req, res: Response<NotesResponse>) => {
  res.json({ notes: listNotes() });
});

app.post("/api/notes", authMiddleware, (req: Request<unknown, Note, NoteInput>, res) => {
  const note = createNote(sanitizeInput(req.body));
  res.status(201).json(note);
});

app.put("/api/notes/:id", authMiddleware, (req: Request<{ id: string }, Note, NoteInput>, res) => {
  const updated = updateNote(req.params.id, sanitizeInput(req.body));
  if (!updated) {
    throw new HttpError(404, "Note not found.");
  }
  res.json(updated);
});

app.delete("/api/notes/:id", authMiddleware, (req: Request<{ id: string }>, res) => {
  if (!deleteNote(req.params.id)) {
    throw new HttpError(404, "Note not found.");
  }
  res.status(204).end();
});

app.post("/api/webhooks/hermes/messages", webhookMiddleware, (req: Request<unknown, unknown, HermesWebhookInput>, res) => {
  const inserted = insertChatMessages(normalizeWebhookInput(req.body));
  res.status(201).json({ inserted: inserted.length, messages: inserted });
});

app.get("/api/chat-messages", authMiddleware, (_req, res: Response<ChatMessagesResponse>) => {
  res.json({ messages: listChatMessages() });
});

app.get("/api/daily-summaries", authMiddleware, (_req, res: Response<DailySummariesResponse>) => {
  res.json({ summaries: listDailySummaries() });
});

app.post("/api/ai/summarize/:date", authMiddleware, async (req: Request<{ date: string }>, res, next) => {
  assertDate(req.params.date);
  const regenerate = req.query.regenerate === "true";
  try {
    const summary = await summarizeDate(req.params.date, { regenerate });
    res.json(summary);
  } catch (error) {
    next(new HttpError(502, error instanceof Error ? error.message : "AI summary failed."));
  }
});

app.get("/api/research-suggestions", authMiddleware, (_req, res: Response<ResearchSuggestionsResponse>) => {
  res.json({ suggestions: listResearchSuggestions() });
});

app.use(express.static(staticDir));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next(new HttpError(404, "API route not found."));
    return;
  }
  res.sendFile(path.join(staticDir, "index.html"));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  res.status(status).json({ error: message });
});

app.listen(port, async () => {
  await ensureDatabase();
  startSummaryScheduler();
  console.log(`Stockpulse API listening on http://localhost:${port}`);
});
