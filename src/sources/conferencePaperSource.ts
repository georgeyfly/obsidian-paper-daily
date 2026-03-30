import type { App, TFile } from "obsidian";
import type { Paper, FetchParams } from "../types/paper";
import type { PaperSource } from "./source";
import type { PaperDailySettings, InterestKeyword } from "../types/config";
import { computeInterestHits } from "../scoring/interest";

const BASE_URL = "https://raw.githubusercontent.com/Papercopilot/paperlists/main";

// Status tier order for sorting (lower = higher priority)
const STATUS_TIER: Record<string, number> = {
  oral: 0,
  spotlight: 1,
  poster: 2,
};

function statusTier(status: string | undefined): number {
  if (!status) return 3;
  return STATUS_TIER[status.toLowerCase()] ?? 2;
}

interface PapercopilotEntry {
  id?: string | number;
  title?: string;
  abstract?: string;
  author?: string;
  status?: string;
  track?: string;
  arxiv?: string;
  pdf?: string;
  site?: string;
  gs_citation?: number;
  award?: boolean;
}

function normalizeId(entry: PapercopilotEntry, confKey: string, year: number): string {
  if (entry.arxiv) {
    const arxivId = String(entry.arxiv).trim().replace(/^arxiv:/i, "");
    return `arxiv:${arxivId}`;
  }
  return `conf:${confKey}${year}:${entry.id ?? Math.random().toString(36).slice(2)}`;
}

function parseAuthors(author: string | undefined): string[] {
  if (!author) return [];
  return author.split(/[;,]/).map(a => a.trim()).filter(Boolean);
}

function normalizeEntry(entry: PapercopilotEntry, confName: string, confKey: string, year: number): Paper {
  const now = new Date().toISOString();
  return {
    id: normalizeId(entry, confKey, year),
    title: entry.title ?? "",
    authors: parseAuthors(entry.author),
    abstract: entry.abstract ?? "",
    categories: [],
    published: now,
    updated: now,
    links: {
      html: entry.site ?? undefined,
      pdf: entry.pdf ?? undefined,
    },
    source: "conference",
    conferenceVenue: confName,
    conferenceYear: year,
    paperStatus: entry.status ?? undefined,
    citations: entry.gs_citation ?? 0,
  };
}

export class ConferencePaperSource implements PaperSource {
  name = "conference";
  enabled = true;

  constructor(private app: App) {}

  // Fetch + cache one conference-year. Returns normalized Paper[].
  async fetchConference(
    settings: PaperDailySettings,
    conf: { name: string; key: string; fromYear: number },
    year: number
  ): Promise<Paper[]> {
    const rootFolder = settings.rootFolder ?? "PaperDaily";
    const cachePath = `${rootFolder}/cache/conf_${conf.key}${year}.json`;
    const cacheRefreshDays = settings.conferenceSource?.cacheRefreshDays ?? 7;

    // Try reading cache
    const existing = this.app.vault.getAbstractFileByPath(cachePath) as TFile | null;
    if (existing) {
      const stat = existing.stat;
      const ageMs = Date.now() - stat.mtime;
      if (ageMs < cacheRefreshDays * 86400 * 1000) {
        try {
          const raw = await this.app.vault.read(existing);
          return JSON.parse(raw) as Paper[];
        } catch {
          // fall through to re-fetch
        }
      }
    }

    // Fetch from papercopilot GitHub CDN
    const url = `${BASE_URL}/${conf.key}/${conf.key}${year}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Conference fetch failed: ${response.status} ${url}`);
    }
    const entries: PapercopilotEntry[] = await response.json();
    const papers = entries.map(e => normalizeEntry(e, conf.name, conf.key, year));

    // Cache normalized papers
    const cacheFolder = `${rootFolder}/cache`;
    if (!this.app.vault.getAbstractFileByPath(cacheFolder)) {
      await this.app.vault.createFolder(cacheFolder);
    }
    const cacheContent = JSON.stringify(papers, null, 2);
    if (existing) {
      await this.app.vault.modify(existing, cacheContent);
    } else {
      await this.app.vault.create(cachePath, cacheContent);
    }

    return papers;
  }

  // Filter and rank papers by interest keywords + status, return top N.
  filterAndRank(papers: Paper[], settings: PaperDailySettings): Paper[] {
    const keywords: InterestKeyword[] = settings.interestKeywords ?? [];
    const maxPerConference = settings.conferenceSource?.maxPerConference ?? 20;
    const includeStatuses = (settings.conferenceSource?.includeStatuses ?? ["Oral", "Spotlight", "Poster"])
      .map(s => s.toLowerCase());

    let filtered = papers;

    // Filter by acceptance status if configured
    if (includeStatuses.length > 0) {
      filtered = filtered.filter(p => {
        const s = (p.paperStatus ?? "poster").toLowerCase();
        return includeStatuses.some(allowed => s.includes(allowed));
      });
    }

    // Filter by interest keywords when configured
    if (keywords.length > 0) {
      filtered = filtered.filter(p => computeInterestHits(p, keywords).length > 0);
    }

    // Pre-compute interest hits
    for (const p of filtered) {
      p.interestHits = computeInterestHits(p, keywords);
    }

    // Sort: year desc → status tier → citations desc
    filtered.sort((a, b) => {
      const yearDiff = (b.conferenceYear ?? 0) - (a.conferenceYear ?? 0);
      if (yearDiff !== 0) return yearDiff;
      const tierDiff = statusTier(a.paperStatus) - statusTier(b.paperStatus);
      if (tierDiff !== 0) return tierDiff;
      return (b.citations ?? 0) - (a.citations ?? 0);
    });

    return filtered.slice(0, maxPerConference);
  }

  // Satisfies PaperSource interface (not used in normal pipeline)
  async fetch(_params: FetchParams): Promise<Paper[]> {
    return [];
  }
}
