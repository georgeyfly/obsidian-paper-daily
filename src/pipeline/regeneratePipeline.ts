import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { PaperDailySettings } from "../types/config";
import type { Paper } from "../types/paper";
import { buildLLMProvider, fillTemplate, getActivePrompt } from "./promptHelpers";
import { VaultWriter } from "../storage/vaultWriter";

export async function regenerateDigest(
  app: App,
  settings: PaperDailySettings,
  date: string,
  options: { signal?: AbortSignal; onProgress?: (msg: string) => void }
): Promise<void> {
  const progress = (msg: string) => options.onProgress?.(msg);
  const rootFolder = settings.rootFolder ?? "PaperDaily";
  const snapshotPath = `${rootFolder}/papers/${date}.json`;
  const inboxPath = `${rootFolder}/inbox/${date}.md`;

  // Load snapshot
  progress(`Loading snapshot for ${date}...`);
  let papers: Paper[];
  try {
    const snapshotContent = await app.vault.adapter.read(snapshotPath);
    const snapshot = JSON.parse(snapshotContent) as { date: string; papers: Paper[]; fetchedAt: string };
    papers = snapshot.papers ?? [];
  } catch {
    throw new Error(`No snapshot found for ${date}`);
  }

  // Load existing markdown
  progress(`Loading daily note for ${date}...`);
  let existingContent: string;
  try {
    existingContent = await app.vault.adapter.read(inboxPath);
  } catch {
    throw new Error(`No daily note found for ${date}`);
  }

  // Build LLM prompt (mirrors dailyPipeline.ts Step 4)
  progress(`Building prompt...`);
  const interestKeywords = settings.interestKeywords ?? [];

  const topK = Math.min(papers.length, 20);
  const topPapersForLLM = papers.slice(0, topK).map(p => ({
    id: p.id,
    title: p.title,
    abstract: p.abstract.slice(0, 500),
    categories: p.categories,
    interestHits: p.interestHits ?? [],
    ...(p.hfUpvotes ? { hfUpvotes: p.hfUpvotes } : {}),
    source: p.source,
    published: p.published,
    updated: p.updated,
    links: p.links
  }));

  const hfPapers = papers.filter(p => p.source === "hf");
  const hfForLLM = hfPapers.slice(0, 15).map(p => ({
    title: p.title,
    hfUpvotes: p.hfUpvotes ?? 0,
    ...(p.hfStreak && p.hfStreak > 1 ? { streakDays: p.hfStreak } : {})
  }));

  const hfEnabled = settings.hfSource?.enabled !== false && hfPapers.length > 0;
  const hfDataSection = hfEnabled
    ? `Note: papers with "source": "hf" are HuggingFace-only picks. Treat them identically to arXiv papers.\n\n## HuggingFace Daily Papers (full list for reference, sorted by upvotes):\n${JSON.stringify(hfForLLM, null, 2)}`
    : "";
  const hfSignalSection = hfEnabled
    ? `### HF 社区信号 / HF Community Signal\nFrom the HuggingFace full list, note any papers NOT already covered above. One line each: title + why the community is upvoting it + your take on whether it lives up to the hype.`
    : "";

  const prompt = fillTemplate(getActivePrompt(settings), {
    date,
    papers_json: JSON.stringify(topPapersForLLM, null, 2),
    hf_papers_json: JSON.stringify(hfForLLM, null, 2),
    hf_data_section: hfDataSection,
    hf_signal_section: hfSignalSection,
    fulltext_section: "",
    local_pdfs: "",
    interest_keywords: interestKeywords.map(k => `${k.keyword}(weight:${k.weight})`).join(", "),
    language: settings.language === "zh" ? "Chinese (中文)" : "English"
  });

  // Call LLM
  let digestText: string;
  progress(`Calling LLM (${settings.llm.model})...`);
  try {
    const llm = buildLLMProvider(settings);
    const result = await llm.generate({
      prompt,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
      signal: options.signal
    });
    digestText = result.text;
    progress(`LLM response received (${digestText.length} chars)`);
  } catch (err) {
    digestText = `> **Error**: ${String(err)}`;
    progress(`LLM failed: ${String(err)}`);
  }

  // Replace section in markdown
  const sectionHeader = `\n## 今日要点`;
  const sectionStart = existingContent.indexOf(sectionHeader);
  const newSection = `\n## 今日要点（AI 总结） | by ${settings.llm.model} 老师 🤖\n\n${digestText}`;

  let newContent: string;
  if (sectionStart === -1) {
    newContent = existingContent + `\n\n## 今日要点（AI 总结） | by ${settings.llm.model} 老师 🤖\n\n${digestText}`;
  } else {
    const nextSection = existingContent.indexOf("\n## ", sectionStart + 1);
    const before = existingContent.slice(0, sectionStart);
    const after = nextSection === -1 ? "" : existingContent.slice(nextSection);
    newContent = before + newSection + after;
  }

  const file = app.vault.getAbstractFileByPath(inboxPath);
  if (!(file instanceof TFile)) {
    throw new Error(`Cannot find vault file at ${inboxPath}`);
  }
  await app.vault.modify(file, newContent);

  // Log
  const writer = new VaultWriter(app);
  const logPath = `${rootFolder}/cache/runs.log`;
  const ts = new Date().toISOString();
  const logLine = `\n[${ts}] === Regenerate digest date=${date} model=${settings.llm.model} digestLen=${digestText.length} ===\n`;
  await writer.appendLogWithRotation(logPath, logLine, 512 * 1024);

  progress(`Done — digest regenerated for ${date}`);
}
