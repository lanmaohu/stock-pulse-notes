import crypto from "node:crypto";
import type {
  ContentCreatorOption,
  ContentInsightsPageSize,
  ContentInsightsResponse,
  ContentInsight,
  ContentItem,
  ContentSummarySection,
  ContentStockView,
  Platform
} from "../../shared/types.js";
import { database, withTransaction } from "../database/connection.js";
import { jsonStringArray, optionalString } from "../database/rows.js";

export interface ContentInput {
  platform: Platform;
  externalId: string;
  creatorId: string;
  creatorExternalId: string;
  creatorName: string;
  contentType: ContentItem["contentType"];
  title: string;
  description: string;
  tags: string[];
  sourceUrl: string;
  coverUrl?: string;
  publishedAt: string;
  transcript: string;
  transcriptSource: ContentItem["transcriptSource"];
  status: ContentItem["status"];
  error?: string;
}

export interface ContentStockViewInput {
  symbols: string[];
  companies: string[];
  stance: ContentStockView["stance"];
  coreView: string;
  evidence: string[];
  risks: string[];
  confidence: ContentStockView["confidence"];
  sourceSnippet: string;
  model: string;
}

export interface ContentAnalysisResult {
  summarySections: ContentSummarySection[];
  views: ContentStockViewInput[];
}

type ContentItemRow = Omit<ContentItem, "tags" | "summarySections" | "coverUrl" | "error"> & {
  tags: string;
  summarySections: string;
  coverUrl: string | null;
  error: string | null;
};

type ContentStockViewRow = Omit<ContentStockView, "symbols" | "companies" | "evidence" | "risks"> & {
  symbols: string;
  companies: string;
  evidence: string;
  risks: string;
};

function toContent(row: ContentItemRow): ContentItem {
  return {
    ...row,
    tags: jsonStringArray(row.tags),
    summarySections: summarySectionList(row.summarySections),
    coverUrl: optionalString(row.coverUrl),
    error: optionalString(row.error)
  };
}

function summarySectionList(value: string): ContentSummarySection[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const section = candidate as Record<string, unknown>;
      if (typeof section.heading !== "string" || typeof section.body !== "string" || !Array.isArray(section.sourceQuotes)) return [];
      const heading = section.heading.trim();
      const body = section.body.trim();
      const sourceQuotes = section.sourceQuotes
        .filter((quote): quote is string => typeof quote === "string")
        .map((quote) => quote.trim())
        .filter(Boolean)
        .slice(0, 2);
      return heading && body && sourceQuotes.length ? [{ heading, body, sourceQuotes }] : [];
    }).slice(0, 5);
  } catch {
    return [];
  }
}

function toView(row: ContentStockViewRow): ContentStockView {
  return {
    ...row,
    symbols: jsonStringArray(row.symbols),
    companies: jsonStringArray(row.companies),
    evidence: jsonStringArray(row.evidence),
    risks: jsonStringArray(row.risks)
  };
}

export function listContentCreatorOptions(): ContentCreatorOption[] {
  return database().prepare(`
    SELECT c.id, c.name, c.platform
    FROM creators c
    WHERE c.platform <> 'twitter'
      AND EXISTS (SELECT 1 FROM content_items i WHERE i.creatorId = c.id)
    ORDER BY lower(c.name) ASC, c.id ASC
  `).all() as unknown as ContentCreatorOption[];
}

export function upsertContent(input: ContentInput): { content: ContentItem; isNew: boolean } {
  const connection = database();
  const existing = connection
    .prepare("SELECT * FROM content_items WHERE platform = ? AND externalId = ?")
    .get(input.platform, input.externalId) as ContentItemRow | undefined;
  const now = new Date().toISOString();
  const id = existing?.id || crypto.randomUUID();
  const sourceRank: Record<ContentItem["transcriptSource"], number> = { metadata: 0, body: 1, subtitle: 2 };
  const upgradedTranscript = existing ? sourceRank[input.transcriptSource] > sourceRank[existing.transcriptSource] : false;
  const preserveTranscript = existing ? sourceRank[input.transcriptSource] < sourceRank[existing.transcriptSource] : false;
  const transcript = preserveTranscript && existing ? existing.transcript : input.transcript;
  const transcriptSource = preserveTranscript && existing ? existing.transcriptSource : input.transcriptSource;
  const status = preserveTranscript && existing ? existing.status : input.status;
  const contentError = preserveTranscript && existing ? existing.error : input.error;
  const analysisStatus = upgradedTranscript || existing?.analysisStatus === "error"
    ? "pending"
    : existing?.analysisStatus || "pending";
  const summarySections = upgradedTranscript ? "[]" : existing?.summarySections || "[]";
  connection.prepare(`
    INSERT INTO content_items (
      id, platform, externalId, creatorId, creatorExternalId, creatorName, contentType, title, description,
      tags, sourceUrl, coverUrl, publishedAt, collectedAt, transcript, transcriptSource, status,
      summarySections, analysisStatus, error, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, externalId) DO UPDATE SET
      creatorId = excluded.creatorId,
      creatorExternalId = excluded.creatorExternalId,
      creatorName = excluded.creatorName,
      title = excluded.title,
      description = excluded.description,
      tags = excluded.tags,
      sourceUrl = excluded.sourceUrl,
      coverUrl = excluded.coverUrl,
      publishedAt = excluded.publishedAt,
      transcript = excluded.transcript,
      transcriptSource = excluded.transcriptSource,
      status = excluded.status,
      summarySections = excluded.summarySections,
      analysisStatus = excluded.analysisStatus,
      error = excluded.error,
      updatedAt = excluded.updatedAt
  `).run(
    id,
    input.platform,
    input.externalId,
    input.creatorId,
    input.creatorExternalId,
    input.creatorName,
    input.contentType,
    input.title.slice(0, 300),
    input.description.slice(0, 10_000),
    JSON.stringify(input.tags.slice(0, 30)),
    input.sourceUrl,
    input.coverUrl || null,
    input.publishedAt,
    existing?.collectedAt || now,
    transcript.slice(0, 120_000),
    transcriptSource,
    status,
    summarySections,
    analysisStatus,
    contentError || null,
    existing?.createdAt || now,
    now
  );
  const row = connection
    .prepare("SELECT * FROM content_items WHERE platform = ? AND externalId = ?")
    .get(input.platform, input.externalId) as ContentItemRow;
  return { content: toContent(row), isNew: !existing };
}

export function getContentItem(id: string): ContentItem | null {
  const row = database().prepare("SELECT * FROM content_items WHERE id = ?").get(id) as ContentItemRow | undefined;
  return row ? toContent(row) : null;
}

export function getContentInsight(id: string): ContentInsight | null {
  const connection = database();
  const contentRow = connection.prepare("SELECT * FROM content_items WHERE id = ?").get(id) as ContentItemRow | undefined;
  if (!contentRow) return null;
  const viewRows = connection.prepare(`
    SELECT * FROM content_stock_views WHERE contentId = ? ORDER BY createdAt ASC
  `).all(id) as ContentStockViewRow[];
  return { content: toContent(contentRow), views: viewRows.map(toView) };
}

export function markContentAnalysisStatus(id: string, status: ContentItem["analysisStatus"], error?: string) {
  database().prepare("UPDATE content_items SET analysisStatus = ?, error = ?, updatedAt = ? WHERE id = ?")
    .run(status, error || null, new Date().toISOString(), id);
}

export function beginContentAnalysisRetry(id: string) {
  const result = database().prepare(`
    UPDATE content_items SET analysisStatus = 'running', error = NULL, updatedAt = ?
    WHERE id = ? AND analysisStatus = 'error'
  `).run(new Date().toISOString(), id);
  return Number(result.changes) === 1;
}

export function resetContentAnalysis(id: string) {
  const result = database().prepare(`
    UPDATE content_items SET analysisStatus = 'pending', error = NULL, updatedAt = ?
    WHERE id = ? AND analysisStatus = 'running'
  `).run(new Date().toISOString(), id);
  return Number(result.changes) === 1;
}

export function saveContentAnalysis(content: ContentItem, analysis: ContentAnalysisResult) {
  const now = new Date().toISOString();
  withTransaction((connection) => {
    connection.prepare("DELETE FROM content_stock_views WHERE contentId = ?").run(content.id);
    const insert = connection.prepare(`
      INSERT INTO content_stock_views (
        id, contentId, platform, creatorId, creatorExternalId, creatorName, title, sourceUrl, publishedAt,
        collectedAt, symbols, companies, stance, coreView, evidence, risks, confidence, sourceSnippet, model, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const view of analysis.views.slice(0, 12)) {
      insert.run(
        crypto.randomUUID(), content.id, content.platform, content.creatorId, content.creatorExternalId,
        content.creatorName, content.title, content.sourceUrl, content.publishedAt, content.collectedAt,
        JSON.stringify(view.symbols.slice(0, 8)), JSON.stringify(view.companies.slice(0, 8)), view.stance,
        view.coreView.slice(0, 2_000), JSON.stringify(view.evidence.slice(0, 8)), JSON.stringify(view.risks.slice(0, 8)),
        view.confidence, view.sourceSnippet.slice(0, 1_000), view.model, now
      );
    }
    const summarySections = analysis.summarySections.slice(0, 5).map((section) => ({
      heading: section.heading.slice(0, 80),
      body: section.body.slice(0, 1_200),
      sourceQuotes: section.sourceQuotes.slice(0, 2).map((quote) => quote.slice(0, 500))
    }));
    connection.prepare(`
      UPDATE content_items
      SET summarySections = ?, analysisStatus = 'success', error = NULL, updatedAt = ?
      WHERE id = ?
    `).run(JSON.stringify(summarySections), now, content.id);
  });
}

export function listContentInsights(options: {
  publishedDate?: string;
  collectedDate?: string;
  creatorId?: string;
  query?: string;
  page?: number;
  pageSize?: ContentInsightsPageSize;
} = {}): ContentInsightsResponse {
  const clauses: string[] = ["c.platform <> 'twitter'"];
  const values: Array<string | number> = [];
  const filteredDate = options.publishedDate || options.collectedDate;
  if (filteredDate) {
    const start = new Date(`${filteredDate}T00:00:00.000+08:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
    const column = options.publishedDate ? "publishedAt" : "collectedAt";
    clauses.push(`c.${column} >= ? AND c.${column} < ?`);
    values.push(start.toISOString(), end.toISOString());
  }
  if (options.creatorId) {
    clauses.push("c.creatorId = ?");
    values.push(options.creatorId);
  }
  if (options.query) {
    const query = `%${options.query.toLowerCase()}%`;
    clauses.push(`(
      lower(c.creatorName) LIKE ? OR lower(c.title) LIKE ? OR lower(c.description) LIKE ? OR
      EXISTS (
        SELECT 1 FROM content_stock_views v
        WHERE v.contentId = c.id AND (
          lower(v.coreView) LIKE ? OR lower(v.symbols) LIKE ? OR lower(v.companies) LIKE ?
        )
      )
    )`);
    values.push(query, query, query, query, query, query);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const pageSize = options.pageSize || 10;
  const requestedPage = options.page || 1;
  const connection = database();
  const aggregate = connection.prepare(`
    WITH filtered_content AS (SELECT c.id FROM content_items c ${where}), targets AS (
      SELECT trim(CAST(symbol.value AS TEXT)) AS target
      FROM content_stock_views v JOIN filtered_content f ON f.id = v.contentId, json_each(v.symbols) symbol
      UNION
      SELECT trim(CAST(company.value AS TEXT)) AS target
      FROM content_stock_views v JOIN filtered_content f ON f.id = v.contentId, json_each(v.companies) company
    )
    SELECT
      (SELECT COUNT(*) FROM filtered_content) AS contentCount,
      (SELECT COUNT(*) FROM content_stock_views v JOIN filtered_content f ON f.id = v.contentId) AS viewCount,
      (SELECT COUNT(*) FROM targets WHERE target <> '') AS targetCount
  `).get(...values) as { contentCount: number; viewCount: number; targetCount: number };
  const totalPages = aggregate.contentCount ? Math.ceil(aggregate.contentCount / pageSize) : 0;
  const page = totalPages ? Math.min(requestedPage, totalPages) : 1;
  const contentRows = connection.prepare(`
    SELECT c.* FROM content_items c ${where}
    ORDER BY c.publishedAt DESC, c.collectedAt DESC, c.id DESC LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize) as ContentItemRow[];
  const pagination = { page, pageSize, totalItems: aggregate.contentCount, totalPages };
  const summary = { ...aggregate };
  if (!contentRows.length) return { insights: [], pagination, summary };
  const ids = contentRows.map((row) => row.id);
  const viewRows = connection.prepare(`
    SELECT * FROM content_stock_views WHERE contentId IN (${ids.map(() => "?").join(",")}) ORDER BY createdAt ASC
  `).all(...ids) as ContentStockViewRow[];
  const viewsByContent = new Map<string, ContentStockView[]>();
  for (const row of viewRows) {
    const views = viewsByContent.get(row.contentId) || [];
    views.push(toView(row));
    viewsByContent.set(row.contentId, views);
  }
  return {
    insights: contentRows.map((row) => ({ content: toContent(row), views: viewsByContent.get(row.id) || [] })),
    pagination,
    summary
  };
}
