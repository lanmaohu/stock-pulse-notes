import type { Creator, CreatorCandidate, Platform, PlatformAccount } from "../../shared/types.js";

export type PlatformErrorCode =
  | "auth_required"
  | "rate_limited"
  | "creator_not_found"
  | "content_unavailable"
  | "transcript_unavailable"
  | "platform_error";

export class PlatformError extends Error {
  constructor(
    public code: PlatformErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface PlatformAccountIdentity {
  externalUserId: string;
  displayName: string;
  avatarUrl?: string;
}

export interface CollectedContent {
  externalId: string;
  contentType: "video" | "note";
  title: string;
  description: string;
  tags: string[];
  sourceUrl: string;
  coverUrl?: string;
  publishedAt: string;
  transcript: string;
  transcriptSource: "subtitle" | "metadata";
  status: "ready" | "metadata_only";
  warning?: string;
}

export interface PlatformAdapter {
  platform: Platform;
  checkAccount(credential: string): Promise<PlatformAccountIdentity>;
  searchCreators(query: string, credential: string): Promise<CreatorCandidate[]>;
  resolveCreator(externalId: string, credential: string): Promise<CreatorCandidate>;
  listCreatorContent(creator: Creator, credential: string, limit: number): Promise<CollectedContent[]>;
}

export interface StoredPlatformAccount extends PlatformAccount {
  encryptedCredential: string;
}
