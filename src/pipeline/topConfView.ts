import type { ConfDbRecord } from "../types/paper";

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, "").trim();
}

function statusLabel(status: string | undefined): string {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

function scoreForSort(r: ConfDbRecord): number {
  return r.llmScore ?? -1;
}

export function renderTopConfMarkdown(records: ConfDbRecord[]): string {
  const sorted = [...records].sort((a, b) => {
    const diff = scoreForSort(b) - scoreForSort(a);
    if (diff !== 0) return diff;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });

  const header = [
    "---",
    "type: paper-daily-topconf",
    `generatedAt: ${new Date().toISOString()}`,
    `total: ${sorted.length}`,
    "---",
    "",
    "# Top Conference Papers",
    "",
    "> Persistent, AI-rated index of all conference papers ingested so far.",
    "> Rebuilt after each conference refresh. Sort: score desc.",
    "",
    "| # | Title | Venue | Score | Summary | Hits | Shared? |",
    "|---|-------|-------|-------|---------|------|---------|",
  ];

  if (sorted.length === 0) {
    return header.concat(["| — | _No papers rated yet_ | | | | | |", ""]).join("\n");
  }

  const rows = sorted.map((r, i) => {
    const titleLink = r.links?.html
      ? `[${escapeTableCell(r.title)}](${r.links.html})`
      : escapeTableCell(r.title);
    const venueParts = [
      r.conferenceVenue ? `${r.conferenceVenue} ${r.conferenceYear ?? ""}`.trim() : "",
      statusLabel(r.paperStatus),
    ].filter(Boolean);
    const venue = venueParts.join(" · ") || "-";
    const score = r.llmScore != null ? `⭐${r.llmScore}/10` : "-";
    const summary = escapeTableCell(r.llmSummary ?? "") || "-";
    const hits = (r.interestHits ?? []).slice(0, 3).join(", ") || "-";
    const shared = r.sharedDates.length > 0 ? `✓ ${r.sharedDates[r.sharedDates.length - 1]}` : "";
    return `| ${i + 1} | ${titleLink} | ${venue} | ${score} | ${summary} | ${hits} | ${shared} |`;
  });

  return header.concat(rows, [""]).join("\n");
}
