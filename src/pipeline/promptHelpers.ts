import type { PaperDailySettings } from "../types/config";
import { OpenAICompatibleProvider } from "../llm/openaiCompatible";
import { AnthropicProvider } from "../llm/anthropicProvider";
import type { LLMProvider } from "../llm/provider";
import { DEFAULT_SCORING_PROMPT, DEFAULT_CONF_SCORING_PROMPT } from "../settings";

export function buildLLMProvider(settings: PaperDailySettings): LLMProvider {
  if (settings.llm.provider === "anthropic") {
    return new AnthropicProvider(settings.llm.apiKey, settings.llm.model);
  }
  return new OpenAICompatibleProvider(settings.llm.baseUrl, settings.llm.apiKey, settings.llm.model);
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
  }
  return result;
}

export function getActivePrompt(settings: PaperDailySettings): string {
  if (settings.promptLibrary && settings.activePromptId) {
    const tpl = settings.promptLibrary.find(t => t.id === settings.activePromptId);
    if (tpl) return tpl.prompt;
  }
  return settings.llm.dailyPromptTemplate; // fallback for existing users
}

export function getActiveScoringPrompt(settings: PaperDailySettings): string {
  if (settings.promptLibrary && settings.activeScorePromptId) {
    const tpl = settings.promptLibrary.find(t => t.id === settings.activeScorePromptId);
    if (tpl) return tpl.prompt;
  }
  return settings.scoringPromptTemplate ?? DEFAULT_SCORING_PROMPT;
}

export function getActiveConfScoringPrompt(settings: PaperDailySettings): string {
  if (settings.promptLibrary && settings.activeConfScorePromptId) {
    const tpl = settings.promptLibrary.find(t => t.id === settings.activeConfScorePromptId);
    if (tpl) return tpl.prompt;
  }
  return DEFAULT_CONF_SCORING_PROMPT;
}
