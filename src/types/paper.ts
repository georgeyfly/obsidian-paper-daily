export type PaperSource = "arxiv" | "rss" | "custom" | "hf" | "conference";

export interface Paper {
  id: string;               // e.g. "arxiv:2501.12345v2"
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string;        // ISO
  updated: string;          // ISO
  links: { html?: string; pdf?: string; hf?: string };
  source: PaperSource;

  // HuggingFace enrichment
  hfUpvotes?: number;
  hfStreak?: number;   // consecutive days on HF daily (tracked across runs)

  // Conference source metadata
  conferenceVenue?: string;   // e.g. "NeurIPS"
  conferenceYear?: number;    // e.g. 2024
  paperStatus?: string;       // "Oral" | "Spotlight" | "Poster"
  citations?: number;         // Google Scholar citation count

  // computed fields
  interestHits?: string[];
  llmScore?: number;
  llmScoreReason?: string;
  llmSummary?: string;
  deepReadAnalysis?: string;   // Stage 2 per-paper LLM analysis
}

export interface FetchParams {
  categories: string[];
  keywords: string[];
  maxResults: number;
  sortBy: "submittedDate" | "lastUpdatedDate";
  // time window filter
  windowStart: Date;
  windowEnd: Date;
  // optional: for backfill, override time window label
  targetDate?: string; // YYYY-MM-DD
}

export interface RunState {
  lastDailyRun: string;    // ISO or ""
  lastConfRefresh?: string; // ISO of last successful conference DB refresh
  lastError: {
    time: string;
    stage: "fetch" | "llm" | "write" | "";
    message: string;
  } | null;
}

export type DedupMap = Record<string, string>; // paperId -> firstSeenDate (YYYY-MM-DD)

export interface DailySnapshot {
  date: string;             // YYYY-MM-DD
  papers: Paper[];
  fetchedAt: string;        // ISO
  error?: string;
}

export interface ConfDbRecord {
  id: string;                       // normalized id (no "arxiv:" prefix, no version suffix, lowercased)
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  links: { html?: string; pdf?: string; hf?: string };
  conferenceVenue?: string;
  conferenceYear?: number;
  paperStatus?: string;
  citations?: number;
  interestHits: string[];
  llmScore?: number;
  llmScoreReason?: string;
  llmSummary?: string;
  ratedAt?: string;                 // YYYY-MM-DD — first time LLM-rated
  sharedDates: string[];            // daily-report dates this paper was surfaced in
  firstSeenAt: string;              // YYYY-MM-DD — first time ingested into DB
}

export type ConfDbMap = Record<string, ConfDbRecord>;
