export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoginResponse {
  token: string;
}

export interface NotesResponse {
  notes: Note[];
}

export interface HealthResponse {
  ok: true;
  service: "stockpulse";
}

export type NoteInput = Partial<Pick<Note, "title" | "content" | "tags" | "pinned">>;
