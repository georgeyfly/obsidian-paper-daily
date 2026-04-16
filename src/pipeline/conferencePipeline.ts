import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { PaperDailySettings } from "../types/config";
import type { ConfDbRecord, Paper } from "../types/paper";
import { ConferencePaperSource } from "../sources/conferencePaperSource";
import { computeInterestHits } from "../scoring/interest";
import { buildLLMProvider, fillTemplate, getActiveConfScoringPrompt } from "./promptHelpers";
import { localDateStr } from "./dailyPipeline";
import { VaultWriter } from "../storage/vaultWriter";
import { ConfDbStore, normalizeConfId } from "../storage/confDbStore";
import { renderTopConfMarkdown } from "./topConfView";

export class PipelineAbortError extends Error {}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineAbortError("Aborted");
}

function paperToRecord(p: Paper, firstSeenAt: string): ConfDbRecord {
  return {
    id: normalizeConfId(p.id),
    title: p.title,
    authors: p.authors,
    abstract: p.abstract,
    categories: p.categories,
    links: { html: p.links?.html, pdf: p.links?.pdf, hf: p.links?.hf },
    conferenceVenue: p.conferenceVenue,
    conferenceYear: p.conferenceYear,
    paperStatus: p.paperStatus,
    citations: p.citations,
    interestHits: p.interestHits ?? [],
    llmScore: p.llmScore,
    llmScoreReason: p.llmScoreReason,
    llmSummary: p.llmSummary,
    ratedAt: p.llmScore != null ? firstSeenAt : undefined,
    sharedDates: [],
    firstSeenAt,
  };
}

/**
 * Refresh the conference paper database:
 *   1. Fetch all enabled conferences.
 *   2. For any paper NOT already in the DB, LLM-score it once using the conf-scoring prompt.
 *   3. Upsert new records into conf_db.json.
 *   4. Rebuild topconf.md from the DB.
 *
 * Does NOT append to any inbox and does NOT touch seen_ids.json — the daily pipeline
 * is responsible for picking papers from the DB and marking them as shared.
 */
export async function runConferencePipeline(
  app: App,
  settings: PaperDailySettings,
  confDbStore: ConfDbStore,
  options: {
    date?: string;
    onProgress?: (msg: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<void> {
  const log = (msg: string) => options.onProgress?.(msg);
  const reportDate = options.date ?? localDateStr(new Date());

  checkAbort(options.signal);

  const confSource = new ConferencePaperSource(app);
  const currentYear = new Date().getFullYear();
  const conferences = settings.conferenceSource?.conferences ?? [];
  const interestKeywords = settings.interestKeywords ?? [];

  const fetched: Paper[] = [];
  for (const conf of conferences) {
    if (!conf.enabled) continue;
    const fromYear = conf.fromYear ?? 2024;
    for (let year = fromYear; year <= currentYear + 1; year++) {
      checkAbort(options.signal);
      try {
        const raw = await confSource.fetchConference(settings, conf, year);
        const filtered = confSource.filterAndRank(raw, settings);
        fetched.push(...filtered);
        log(`CONF: ${conf.name} ${year} → ${filtered.length} papers`);
      } catch {
        log(`CONF: ${conf.name} ${year} not available, skipping`);
      }
    }
  }

  if (fetched.length === 0) {
    log("CONF: no conference papers found (check settings — enable conferences)");
    return;
  }

  for (const p of fetched) {
    p.interestHits = computeInterestHits(p, interestKeywords);
  }

  // Dedupe within this fetch (same id may come from multiple years) and split against DB.
  const seenInFetch = new Set<string>();
  const newPapers: Paper[] = [];
  let alreadyInDb = 0;
  for (const p of fetched) {
    const key = normalizeConfId(p.id);
    if (seenInFetch.has(key)) continue;
    seenInFetch.add(key);
    if (confDbStore.has(key)) {
      alreadyInDb++;
      continue;
    }
    newPapers.push(p);
  }
  log(`CONF REFRESH: rating ${newPapers.length} new papers (${alreadyInDb} already in DB)`);

  // LLM-score only the new bucket.
  if (newPapers.length > 0 && settings.llm.apiKey) {
    const BATCH_SIZE = 10;
    const scoringTemplate = getActiveConfScoringPrompt(settings);
    const kwStr = interestKeywords.map(k => `${k.keyword}(weight:${k.weight})`).join(", ");
    const llm = buildLLMProvider(settings);

    for (let i = 0; i < newPapers.length; i += BATCH_SIZE) {
      checkAbort(options.signal);
      const batch = newPapers.slice(i, i + BATCH_SIZE);
      const paperFrom = i + 1;
      const paperTo = i + batch.length;
      log(`CONF SCORE: scoring ${paperFrom}–${paperTo} / ${newPapers.length}...`);

      const papersForScoring = batch.map(p => ({
        id: p.id,
        title: p.title,
        abstract: p.abstract.slice(0, 250),
        interestHits: p.interestHits ?? [],
        conferenceVenue: p.conferenceVenue,
        conferenceYear: p.conferenceYear,
        paperStatus: p.paperStatus,
      }));
      const maxTokens = Math.min(batch.length * 150 + 256, 8192);
      const prompt = fillTemplate(scoringTemplate, {
        interest_keywords: kwStr,
        papers_json: JSON.stringify(papersForScoring),
      });

      try {
        const result = await llm.generate({ prompt, temperature: 0.1, maxTokens, signal: options.signal });
        const jsonMatch = result.text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const scores: Array<{ id: string; score: number; reason: string; summary?: string }> = JSON.parse(jsonMatch[0]);
          const scoreMap = new Map(scores.map(s => [normalizeConfId(s.id), s]));
          for (const paper of batch) {
            const s = scoreMap.get(normalizeConfId(paper.id));
            if (s) {
              paper.llmScore = s.score;
              paper.llmScoreReason = s.reason;
              if (s.summary) paper.llmSummary = s.summary;
            }
          }
        }
      } catch (err) {
        log(`CONF SCORE: batch error — ${String(err)} (continuing)`);
      }
    }
  } else if (newPapers.length > 0) {
    log(`CONF SCORE: skipped (no API key) — papers stored without LLM scores`);
  }

  // Upsert all new papers into the DB.
  for (const p of newPapers) {
    confDbStore.upsert(paperToRecord(p, reportDate));
  }
  await confDbStore.save();

  // Rebuild topconf.md.
  const writer = new VaultWriter(app);
  const topConfPath = normalizePath(`${settings.rootFolder}/topconf.md`);
  await writer.writeNote(topConfPath, renderTopConfMarkdown(confDbStore.getAll()));
  log(`CONF REFRESH: DB size=${confDbStore.size()} — topconf.md rebuilt at ${topConfPath}`);
}
