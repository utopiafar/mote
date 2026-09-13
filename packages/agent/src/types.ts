export interface ContextRecord {
  id: string;
  capturedAt: string;
  appName: string;
  ocrText: string;
  summary?: string;
  deviceId?: string;
  sourceType?: string;
  [field: string]: unknown;
}

export interface ContextRange {
  after?: string;
  before?: string;
  deviceId?: string;
  limit?: number;
}

export interface ContextReader {
  search(args: ContextRange & { query?: string }): Promise<ContextRecord[]>;
  timeline(args: ContextRange): Promise<ContextRecord[]>;
  evidence(args: { ids: string[] }): Promise<ContextRecord[]>;
  activity(args: ContextRange): Promise<unknown>;
  devices(): Promise<unknown>;
}

export interface AgentOptions {
  reader: ContextReader;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Explicit opt-in for a local endpoint that does not need a credential. */
  allowUnauthenticatedLocal?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
}

export interface QueryInput {
  question: string;
  after?: string;
  before?: string;
}
export interface Citation {
  id: string;
  capturedAt: string;
  appName: string;
  excerpt: string;
}
export interface ToolTrace {
  tool: string;
  arguments: Record<string, unknown>;
  count: number;
}
export interface AgentAnswer {
  answer: string;
  citations: Citation[];
  trace: ToolTrace[];
  runId: string;
}

export class AgentNotConfiguredError extends Error {
  readonly statusCode = 503;
  constructor() {
    super(
      "Configure an agent model and its API credential before asking Mote.",
    );
    this.name = "AgentNotConfiguredError";
  }
}

export class AgentResponseError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = "AgentResponseError";
  }
}
