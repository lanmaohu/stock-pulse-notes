import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HealthResponse, LoginResponse, Note, NoteInput, NotesResponse } from "../shared/types.js";

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

const dataDir = `${process.cwd()}/data`;
const notesPath = path.join(dataDir, "notes.json");
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
app.use(express.json({ limit: "1mb" }));

async function ensureDataFile() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(notesPath);
  } catch {
    await fs.writeFile(notesPath, "[]\n", "utf8");
  }
}

async function readNotes(): Promise<Note[]> {
  await ensureDataFile();
  const raw = await fs.readFile(notesPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new HttpError(500, "Notes data is corrupted.");
  }
  return parsed as Note[];
}

async function writeNotes(notes: Note[]) {
  await ensureDataFile();
  const tmpPath = `${notesPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, notesPath);
}

function requireSecret(name: "NOTES_PASSWORD" | "SESSION_SECRET") {
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

function sortNotes(notes: Note[]) {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

app.get("/api/health", (_req, res: Response<HealthResponse>) => {
  res.json({ ok: true, service: "stockpulse" });
});

app.post("/api/login", (req: Request<unknown, LoginResponse, { password?: string }>, res) => {
  const password = requireSecret("NOTES_PASSWORD");
  if (req.body.password !== password) {
    throw new HttpError(401, "密码不正确。");
  }
  res.json({ token: createToken() });
});

app.get("/api/notes", authMiddleware, async (_req, res: Response<NotesResponse>) => {
  const notes = await readNotes();
  res.json({ notes: sortNotes(notes) });
});

app.post("/api/notes", authMiddleware, async (req: Request<unknown, Note, NoteInput>, res) => {
  const notes = await readNotes();
  const now = new Date().toISOString();
  const clean = sanitizeInput(req.body);
  const note: Note = {
    id: crypto.randomUUID(),
    ...clean,
    createdAt: now,
    updatedAt: now
  };
  await writeNotes([note, ...notes]);
  res.status(201).json(note);
});

app.put("/api/notes/:id", authMiddleware, async (req: Request<{ id: string }, Note, NoteInput>, res) => {
  const notes = await readNotes();
  const index = notes.findIndex((note) => note.id === req.params.id);
  if (index === -1) {
    throw new HttpError(404, "Note not found.");
  }
  const clean = sanitizeInput({ ...notes[index], ...req.body });
  const updated: Note = {
    ...notes[index],
    ...clean,
    updatedAt: new Date().toISOString()
  };
  notes[index] = updated;
  await writeNotes(notes);
  res.json(updated);
});

app.delete("/api/notes/:id", authMiddleware, async (req, res) => {
  const notes = await readNotes();
  const nextNotes = notes.filter((note) => note.id !== req.params.id);
  if (nextNotes.length === notes.length) {
    throw new HttpError(404, "Note not found.");
  }
  await writeNotes(nextNotes);
  res.status(204).end();
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
  await ensureDataFile();
  console.log(`Stockpulse API listening on http://localhost:${port}`);
});
