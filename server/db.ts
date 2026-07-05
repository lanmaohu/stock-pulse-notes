import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  DailySummary,
  HermesMessageInput,
  Note,
  NoteInput,
  ResearchSuggestion
} from "../shared/types.js";

const dataDir = path.join(process.cwd(), "data");
const legacyNotesPath = path.join(dataDir, "notes.json");
const dbPath = path.join(dataDir, "stockpulse.sqlite");

let db: DatabaseSync | null = null;

type NoteRow = Omit<Note, "tags" | "pinned"> & { tags: string; pinned: number };
type ChatMessageRow = ChatMessage;
type DailySummaryRow = Omit<
  DailySummary,
  "coreViews" | "insights" | "investmentThemes" | "evidence" | "risks" | "questions" | "nextSteps"
> & {
  coreViews: string;
  insights: string;
  investmentThemes: string;
  evidence: string;
  risks: string;
  questions: string;
  nextSteps: string;
};
type ResearchSuggestionRow = Omit<ResearchSuggestion, "risks" | "validationSteps"> & {
  risks: string;
  validationSteps: string;
};

export interface SummaryInput {
  date: string;
  coreViews: string[];
  insights: string[];
  investmentThemes: string[];
  evidence: string[];
  risks: string[];
  questions: string[];
  nextSteps: string[];
  disclaimer: string;
  sourceMessageCount: number;
  sourceNoteCount: number;
  model: string;
}

export interface SuggestionInput {
  title: string;
  thesis: string;
  rationale: string;
  risks: string[];
  validationSteps: string[];
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toNote(row: NoteRow): Note {
  return {
    ...row,
    pinned: Boolean(row.pinned),
    tags: jsonArray(row.tags)
  };
}

function toDailySummary(row: DailySummaryRow): DailySummary {
  return {
    ...row,
    coreViews: jsonArray(row.coreViews),
    insights: jsonArray(row.insights),
    investmentThemes: jsonArray(row.investmentThemes),
    evidence: jsonArray(row.evidence),
    risks: jsonArray(row.risks),
    questions: jsonArray(row.questions),
    nextSteps: jsonArray(row.nextSteps)
  };
}

function toResearchSuggestion(row: ResearchSuggestionRow): ResearchSuggestion {
  return {
    ...row,
    risks: jsonArray(row.risks),
    validationSteps: jsonArray(row.validationSteps)
  };
}

function database() {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate();
  }
  return db;
}

function migrate() {
  const conn = db!;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      externalId TEXT NOT NULL,
      source TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      messageAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      UNIQUE(source, externalId)
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      coreViews TEXT NOT NULL,
      insights TEXT NOT NULL,
      investmentThemes TEXT NOT NULL,
      evidence TEXT NOT NULL,
      risks TEXT NOT NULL,
      questions TEXT NOT NULL,
      nextSteps TEXT NOT NULL,
      disclaimer TEXT NOT NULL,
      sourceMessageCount INTEGER NOT NULL,
      sourceNoteCount INTEGER NOT NULL,
      model TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_suggestions (
      id TEXT PRIMARY KEY,
      summaryId TEXT NOT NULL,
      date TEXT NOT NULL,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      rationale TEXT NOT NULL,
      risks TEXT NOT NULL,
      validationSteps TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(summaryId) REFERENCES daily_summaries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_runs (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      promptTokens INTEGER,
      completionTokens INTEGER,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  const noteCount = conn.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number } | undefined;
  if (noteCount?.count === 0 && fs.existsSync(legacyNotesPath)) {
    const raw = fs.readFileSync(legacyNotesPath, "utf8");
    const legacy = JSON.parse(raw) as Note[];
    const insert = conn.prepare(`
      INSERT OR IGNORE INTO notes (id, title, content, tags, pinned, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const note of legacy) {
      insert.run(
        note.id,
        note.title || "未命名笔记",
        note.content || "",
        JSON.stringify(Array.isArray(note.tags) ? note.tags : []),
        note.pinned ? 1 : 0,
        note.createdAt,
        note.updatedAt
      );
    }
  }
}

export async function ensureDatabase() {
  await fsp.mkdir(dataDir, { recursive: true });
  database();
}

export function listNotes(): Note[] {
  const rows = database()
    .prepare("SELECT * FROM notes ORDER BY pinned DESC, datetime(updatedAt) DESC")
    .all() as NoteRow[];
  return rows.map(toNote);
}

export function createNote(input: Required<Pick<Note, "title" | "content" | "tags" | "pinned">>): Note {
  const note: Note = {
    id: crypto.randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  database()
    .prepare("INSERT INTO notes (id, title, content, tags, pinned, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(note.id, note.title, note.content, JSON.stringify(note.tags), note.pinned ? 1 : 0, note.createdAt, note.updatedAt);
  return note;
}

export function updateNote(id: string, input: Required<Pick<Note, "title" | "content" | "tags" | "pinned">>): Note | null {
  const current = database().prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  if (!current) {
    return null;
  }
  const updated: Note = {
    ...toNote(current),
    ...input,
    updatedAt: new Date().toISOString()
  };
  database()
    .prepare("UPDATE notes SET title = ?, content = ?, tags = ?, pinned = ?, updatedAt = ? WHERE id = ?")
    .run(updated.title, updated.content, JSON.stringify(updated.tags), updated.pinned ? 1 : 0, updated.updatedAt, id);
  return updated;
}

export function deleteNote(id: string) {
  return Number(database().prepare("DELETE FROM notes WHERE id = ?").run(id).changes) > 0;
}

export function insertChatMessages(inputs: HermesMessageInput[]): ChatMessage[] {
  const now = new Date().toISOString();
  const inserted: ChatMessage[] = [];
  const stmt = database().prepare(`
    INSERT OR IGNORE INTO chat_messages (id, externalId, source, sender, content, messageAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const input of inputs) {
    const source = (input.source || "hermes").slice(0, 40);
    const content = input.content.trim();
    if (!content) {
      continue;
    }
    const messageAt = input.messageAt ? new Date(input.messageAt).toISOString() : now;
    const externalId =
      input.externalId ||
      crypto.createHash("sha256").update(`${source}:${input.sender}:${messageAt}:${content}`).digest("hex");
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      externalId,
      source,
      sender: input.sender.trim().slice(0, 80) || "unknown",
      content: content.slice(0, 20000),
      messageAt,
      createdAt: now
    };
    const result = stmt.run(
      message.id,
      message.externalId,
      message.source,
      message.sender,
      message.content,
      message.messageAt,
      message.createdAt
    );
    if (Number(result.changes) > 0) {
      inserted.push(message);
    }
  }

  return inserted;
}

export function listChatMessages(limit = 200): ChatMessage[] {
  return database()
    .prepare("SELECT * FROM chat_messages ORDER BY datetime(messageAt) DESC LIMIT ?")
    .all(limit) as unknown as ChatMessageRow[];
}

export function getDailyContext(date: string) {
  const start = new Date(`${date}T00:00:00.000+08:00`).toISOString();
  const end = new Date(`${date}T23:59:59.999+08:00`).toISOString();
  const messages = database()
    .prepare("SELECT * FROM chat_messages WHERE messageAt BETWEEN ? AND ? ORDER BY datetime(messageAt) ASC")
    .all(start, end) as unknown as ChatMessageRow[];
  const notes = database()
    .prepare("SELECT * FROM notes WHERE updatedAt BETWEEN ? AND ? ORDER BY datetime(updatedAt) ASC")
    .all(start, end) as NoteRow[];
  return { messages, notes: notes.map(toNote) };
}

export function getSummaryByDate(date: string): DailySummary | null {
  const row = database().prepare("SELECT * FROM daily_summaries WHERE date = ?").get(date) as DailySummaryRow | undefined;
  return row ? toDailySummary(row) : null;
}

export function listDailySummaries(limit = 30): DailySummary[] {
  const rows = database()
    .prepare("SELECT * FROM daily_summaries ORDER BY date DESC LIMIT ?")
    .all(limit) as DailySummaryRow[];
  return rows.map(toDailySummary);
}

export function saveDailySummary(input: SummaryInput, suggestions: SuggestionInput[], regenerate: boolean) {
  const existing = getSummaryByDate(input.date);
  if (existing && !regenerate) {
    return existing;
  }
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  const conn = database();
  conn.exec("BEGIN");
  try {
    conn
      .prepare(
        `INSERT INTO daily_summaries (
          id, date, coreViews, insights, investmentThemes, evidence, risks, questions, nextSteps,
          disclaimer, sourceMessageCount, sourceNoteCount, model, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          coreViews = excluded.coreViews,
          insights = excluded.insights,
          investmentThemes = excluded.investmentThemes,
          evidence = excluded.evidence,
          risks = excluded.risks,
          questions = excluded.questions,
          nextSteps = excluded.nextSteps,
          disclaimer = excluded.disclaimer,
          sourceMessageCount = excluded.sourceMessageCount,
          sourceNoteCount = excluded.sourceNoteCount,
          model = excluded.model,
          updatedAt = excluded.updatedAt`
      )
      .run(
        id,
        input.date,
        JSON.stringify(input.coreViews),
        JSON.stringify(input.insights),
        JSON.stringify(input.investmentThemes),
        JSON.stringify(input.evidence),
        JSON.stringify(input.risks),
        JSON.stringify(input.questions),
        JSON.stringify(input.nextSteps),
        input.disclaimer,
        input.sourceMessageCount,
        input.sourceNoteCount,
        input.model,
        existing?.createdAt || now,
        now
      );

    conn.prepare("DELETE FROM research_suggestions WHERE summaryId = ?").run(id);
    const insertSuggestion = conn.prepare(`
      INSERT INTO research_suggestions
        (id, summaryId, date, title, thesis, rationale, risks, validationSteps, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const suggestion of suggestions.slice(0, 8)) {
      insertSuggestion.run(
        crypto.randomUUID(),
        id,
        input.date,
        suggestion.title.slice(0, 160),
        suggestion.thesis.slice(0, 2000),
        suggestion.rationale.slice(0, 3000),
        JSON.stringify(suggestion.risks),
        JSON.stringify(suggestion.validationSteps),
        now
      );
    }
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
  return getSummaryByDate(input.date)!;
}

export function listResearchSuggestions(limit = 50): ResearchSuggestion[] {
  const rows = database()
    .prepare("SELECT * FROM research_suggestions ORDER BY date DESC, datetime(createdAt) DESC LIMIT ?")
    .all(limit) as ResearchSuggestionRow[];
  return rows.map(toResearchSuggestion);
}

export function createAiRun(date: string, provider: string, model: string) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  database()
    .prepare("INSERT INTO ai_runs (id, date, provider, model, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, date, provider, model, "running", now, now);
  return id;
}

export function finishAiRun(id: string, status: "success" | "error", error?: string, usage?: { prompt?: number; completion?: number }) {
  database()
    .prepare(
      "UPDATE ai_runs SET status = ?, error = ?, promptTokens = ?, completionTokens = ?, updatedAt = ? WHERE id = ?"
    )
    .run(status, error || null, usage?.prompt ?? null, usage?.completion ?? null, new Date().toISOString(), id);
}
