import type { App } from "obsidian";
import { TFile, normalizePath } from "obsidian";
import type { PaperDailySettings } from "../types/config";
import type { Paper } from "../types/paper";
import { ConferencePaperSource } from "../sources/conferencePaperSource";
import { computeInterestHits } from "../scoring/interest";
import { buildLLMProvider, fillTemplate, getActiveConfScoringPrompt } from "./promptHelpers";
import { localDateStr } from "./dailyPipeline";
import { VaultWriter } from "../storage/vaultWriter";
import { DedupStore } from "../storage/dedupStore";

export class PipelineAbortError extends Error {}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineAbortError("Aborted");
}

function statusLabel(status: string | undefined): string {
  if (!status) return "Poster";
  const s = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  return s;
}

function formatConferenceSection(papers: Paper[]): string {
  if (papers.length === 0) return "";

  const venues = [...new Set(papers.map(p =>
    p.conferenceVenue ? `${p.conferenceVenue} ${p.conferenceYear ?? ""}`.trim() : ""
  ).filter(Boolean))].join(" · ");

  const lines: string[] = [
    `## Conference Papers`,
    venues ? `> ${venues}` : "",
    ""
  ];

  papers.forEach((p, i) => {
    const scoreStr = p.llmScore !== undefined ? ` ⭐ ${p.llmScore}/10` : "";
    const reasonStr = p.llmScoreReason ? ` — ${p.llmScoreReason}` : "";
    const venueLine = [
      p.conferenceVenue ? `${p.conferenceVenue} ${p.conferenceYear ?? ""}`.trim() : "",
      p.paperStatus ? statusLabel(p.paperStatus) : ""
    ].filter(Boolean).join(" · ");
    const hits = (p.interestHits ?? []).join(", ");
    const hitsStr = hits ? ` | hits: ${hits}` : "";
    const arxivId = p.id.replace(/^arxiv:/i, "").replace(/v\d+$/i, "");
    const arxivUrl = p.links?.html ?? (arxivId.includes("conf:") ? "" : `https://arxiv.org/abs/${arxivId}`);
    const linkParts = [];
    if (arxivUrl) linkParts.push(`[arXiv](${arxivUrl})`);
    if (p.links?.pdf) linkParts.push(`[PDF](${p.links.pdf})`);
    const linksStr = linkParts.length ? ` · ${linkParts.join(" · ")}` : "";
    const authors = p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " et al." : "");

    lines.push(`${i + 1}. **${p.title}**${scoreStr}${reasonStr}`);
    if (venueLine || hitsStr) lines.push(`   ${venueLine}${hitsStr}`);
    if (p.llmSummary) lines.push(`   ${p.llmSummary}`);
    if (authors) lines.push(`   ${authors}${linksStr}`);
    lines.push("");
  });

  return lines.filter((l, i) => !(i === 1 && l === "")).join("\n");
}

export async function runConferencePipeline(
  app: App,
  settings: PaperDailySettings,
  dedupStore: DedupStore,
  options: {
    date?: string;
    onProgress?: (msg: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<void> {
  const log = (msg: string) => options.onProgress?.(msg);
  const reportDate = options.date ?? localDateStr(new Date());
  const reportPath = normalizePath(`${settings.rootFolder}/inbox/${reportDate}.md`);

  checkAbort(options.signal);

  // Step 1: Fetch conference papers
  const confSource = new ConferencePaperSource(app);
  const currentYear = new Date().getFullYear();
  const conferences = settings.conferenceSource?.conferences ?? [];
  const interestKeywords = settings.interestKeywords ?? [];

  const allConfPapers: Paper[] = [];

  for (const conf of conferences) {
    if (!conf.enabled) continue;
    const fromYear = conf.fromYear ?? 2024;
    for (let year = fromYear; year <= currentYear + 1; year++) {
      checkAbort(options.signal);
      try {
        const raw = await confSource.fetchConference(settings, conf, year);
        const filtered = confSource.filterAndRank(raw, settings);
        allConfPapers.push(...filtered);
        log(`CONF: ${conf.name} ${year} → ${filtered.length} papers`);
      } catch {
        log(`CONF: ${conf.name} ${year} not available, skipping`);
      }
    }
  }

  if (allConfPapers.length === 0) {
    log("CONF: no conference papers found (check settings — enable conferences)");
    return;
  }

  // Compute interest hits
  for (const p of allConfPapers) {
    p.interestHits = computeInterestHits(p, interestKeywords);
  }

  // Filter already-seen papers
  const beforeDedup = allConfPapers.length;
  const fresh = allConfPapers.filter(p => !dedupStore.hasId(p.id));
  log(`CONF DEDUP: ${beforeDedup} → ${fresh.length} papers (${beforeDedup - fresh.length} already seen)`);

  if (fresh.length === 0) {
    log("CONF: all papers already seen — nothing new to recommend");
    return;
  }

  // Step 2: LLM scoring
  let scored: Paper[] = fresh;
  if (settings.llm.apiKey) {
    const BATCH_SIZE = 10;
    const scoringTemplate = getActiveConfScoringPrompt(settings);
    const kwStr = interestKeywords.map(k => `${k.keyword}(weight:${k.weight})`).join(", ");
    const llm = buildLLMProvider(settings);
    const normalizeId = (id: string) => id.replace(/^arxiv:/i, "").replace(/v\d+$/i, "").toLowerCase().trim();

    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      checkAbort(options.signal);
      const batch = fresh.slice(i, i + BATCH_SIZE);
      const paperFrom = i + 1;
      const paperTo = i + batch.length;
      log(`CONF SCORE: scoring ${paperFrom}–${paperTo} / ${fresh.length}...`);

      const papersForScoring = batch.map(p => ({
        id: p.id,
        title: p.title,
        abstract: p.abstract.slice(0, 250),
        interestHits: p.interestHits ?? []
      }));
      const maxTokens = Math.min(batch.length * 150 + 256, 8192);
      const prompt = fillTemplate(scoringTemplate, {
        interest_keywords: kwStr,
        papers_json: JSON.stringify(papersForScoring)
      });

      try {
        const result = await llm.generate({ prompt, temperature: 0.1, maxTokens, signal: options.signal });
        const jsonMatch = result.text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const scores: Array<{ id: string; score: number; reason: string; summary?: string }> = JSON.parse(jsonMatch[0]);
          const scoreMap = new Map(scores.map(s => [normalizeId(s.id), s]));
          for (const paper of batch) {
            const s = scoreMap.get(normalizeId(paper.id));
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

    // Sort by LLM score desc, then cap to maxTotalPerDay
    const maxTotalPerDay = settings.conferenceSource?.maxTotalPerDay ?? 5;
    scored = fresh
      .sort((a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0))
      .slice(0, maxTotalPerDay);
    log(`CONF SCORE: done — ${fresh.filter(p => p.llmScore !== undefined).length}/${fresh.length} scored, showing top ${scored.length}`);
  } else {
    // No API key — sort by status tier + interest hits, still cap
    const maxTotalPerDay = settings.conferenceSource?.maxTotalPerDay ?? 5;
    scored = fresh
      .sort((a, b) => {
        const tierA = ({ oral: 0, spotlight: 1, poster: 2 } as Record<string, number>)[(a.paperStatus ?? "").toLowerCase()] ?? 2;
        const tierB = ({ oral: 0, spotlight: 1, poster: 2 } as Record<string, number>)[(b.paperStatus ?? "").toLowerCase()] ?? 2;
        if (tierA !== tierB) return tierA - tierB;
        return (b.interestHits?.length ?? 0) - (a.interestHits?.length ?? 0);
      })
      .slice(0, maxTotalPerDay);
  }

  // Step 3: Append section to report
  const writer = new VaultWriter(app);
  const exists = await writer.fileExists(reportPath);
  if (!exists) {
    log(`CONF: report not found at ${reportPath} — run daily first`);
    return;
  }

  const file = app.vault.getAbstractFileByPath(reportPath);
  if (!file) {
    log(`CONF: cannot access ${reportPath}`);
    return;
  }

  if (!(file instanceof TFile)) return;

  let content = await app.vault.read(file);
  const section = formatConferenceSection(scored);

  // Replace existing section if present, otherwise append
  const sectionHeader = "## Conference Papers";
  const existingIdx = content.indexOf(sectionHeader);
  if (existingIdx !== -1) {
    // Find end of existing section (next ## heading or EOF)
    const nextHeading = content.indexOf("\n## ", existingIdx + 1);
    const endIdx = nextHeading !== -1 ? nextHeading : content.length;
    content = content.slice(0, existingIdx) + section + content.slice(endIdx);
  } else {
    content = content.trimEnd() + "\n\n" + section;
  }

  await app.vault.modify(file, content);
  log(`CONF: appended ${scored.length} papers to ${reportPath}`);

  // Mark shown papers as seen so they won't be recommended again
  await dedupStore.markSeenBatch(scored.map(p => p.id), reportDate);
  log(`CONF DEDUP: marked ${scored.length} papers as seen`);
}
