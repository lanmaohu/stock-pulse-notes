export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  externalId: string;
  source: string;
  sender: string;
  content: string;
  messageAt: string;
  createdAt: string;
}

export interface DailySummary {
  id: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSuggestion {
  id: string;
  summaryId: string;
  date: string;
  title: string;
  thesis: string;
  rationale: string;
  risks: string[];
  validationSteps: string[];
  createdAt: string;
}

export interface LoginResponse {
  token: string;
}

export interface NotesResponse {
  notes: Note[];
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
}

export interface DailySummariesResponse {
  summaries: DailySummary[];
}

export interface ResearchSuggestionsResponse {
  suggestions: ResearchSuggestion[];
}

export interface HealthResponse {
  ok: true;
  service: "stockpulse";
  storage: "sqlite";
}

export type NoteInput = Partial<Pick<Note, "title" | "content" | "tags" | "pinned">>;

export interface HermesMessageInput {
  externalId?: string;
  source?: string;
  sender: string;
  content: string;
  messageAt?: string;
}

export interface HermesWebhookInput {
  messages?: HermesMessageInput[];
  externalId?: string;
  source?: string;
  sender?: string;
  content?: string;
  messageAt?: string;
}
