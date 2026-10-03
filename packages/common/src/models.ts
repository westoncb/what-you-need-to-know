/** Shared by generation, export, and the website. Never put API keys here. */
export interface ModelSettings {
  model: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

export interface WriterConfig extends ModelSettings {
  /** Stable URL/storage identity; keep this when changing the underlying model. */
  id: string;
  name: string;
}

export type PipelineRole =
  | "readingRationale"
  | "relevanceJudge"
  | "articleSelection"
  | "backgroundContext"
  | "htmlFormatting";

export const modelConfig: {
  stages: Record<PipelineRole, ModelSettings>;
  writers: WriterConfig[];
} = {
  stages: {
    readingRationale: { model: "~openai/gpt-luna-latest", temperature: 0.4, max_tokens: 800 },
    relevanceJudge: { model: "~openai/gpt-luna-latest", temperature: 0 },
    articleSelection: { model: "~openai/gpt-luna-latest", temperature: 0 },
    // Public context and why-to-read notes, generated without the private profile.
    backgroundContext: {
      model: "~openai/gpt-luna-latest", temperature: 0, max_tokens: 600,
      response_format: { type: "json_object" },
    },
    htmlFormatting: { model: "~openai/gpt-luna-latest", temperature: 0.4 },
  },
  // One independent article per entry, all using the same selected sources.
  // Omitted max_tokens preserves the provider's default output limit.
  writers: [
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", model: "anthropic/claude-sonnet-5.5", temperature: 0.7 },
    { id: "gpt-5-6-sol", name: "GPT-5.6 Sol", model: "openai/gpt-5.6-sol", temperature: 0.7 },
  ],
};

const writerIds = new Set<string>();
for (const writer of modelConfig.writers) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(writer.id) || writerIds.has(writer.id)) {
    throw new Error(`Writer IDs must be unique URL slugs: ${writer.id}`);
  }
  writerIds.add(writer.id);
}
if (!writerIds.size) throw new Error("Configure at least one article writer.");
for (const settings of [...Object.values(modelConfig.stages), ...modelConfig.writers]) {
  if (!settings.model.trim()) throw new Error("Each pipeline role and writer needs a model.");
}

export interface ReportIndexEntry {
  day: string;
  headline: string;
  reports: Array<{
    writerId: string;
    model: string;
    file: string;
  }>;
}
