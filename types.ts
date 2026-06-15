// Shared types for Vault Mind.

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  // assistant tool-call requests
  tool_calls?: ToolCall[];
  // for role: "tool" — which call this answers
  tool_call_id?: string;
  name?: string;
}

// A chat attachment (image or text file) added by the user.
export interface Attachment {
  name: string;
  kind: "image" | "text";
  dataUrl?: string; // for images (base64)
  text?: string; // for text files
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number; // USD, from OpenRouter (0 for free models)
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
}

export interface VaultMindSettings {
  apiKey: string;
  model: string;
  freeOnly: boolean;
  maxIterations: number;
  temperature: number;
  topK: number; // retrieval depth
  enableWrites: boolean;
  draftFolder: string;
  skillsFolder: string;
  useSemantic: boolean; // enable local embedding (dense) retrieval channel
  embedModel: string;
  compressContext: boolean; // sawtooth context compression for long sessions
  contextBudgetChars: number; // compress when transcript exceeds this
  githubToken: string;
  githubRepo: string; // owner/repo default
  usePlanner: boolean; // plan-then-execute pre-step
  memories: MemoryItem[]; // long-term memory
}

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
}

export const DEFAULT_SETTINGS: VaultMindSettings = {
  apiKey: "",
  model: "openai/gpt-4o-mini",
  freeOnly: false,
  maxIterations: 12,
  temperature: 0.2,
  topK: 6,
  enableWrites: false,
  draftFolder: "AI Drafts",
  skillsFolder: "Vault Mind Skills",
  useSemantic: false,
  embedModel: "Xenova/multilingual-e5-small",
  compressContext: true,
  contextBudgetChars: 14000,
  githubToken: "",
  githubRepo: "",
  usePlanner: false,
  memories: [],
};

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

// A retrieved chunk, used for [N] citation grounding.
export interface RetrievedChunk {
  n: number; // citation index
  path: string;
  heading: string;
  text: string;
  score: number;
}
