import type { JsonRpcClient } from "../src/types.js";

export interface RecordedRequest {
  method: string;
  params?: unknown;
}

export class FakeClient implements JsonRpcClient {
  readonly requests: RecordedRequest[] = [];
  private readonly responses = new Map<string, unknown>();

  setResponse(method: string, response: unknown): void {
    this.responses.set(method, response);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (!this.responses.has(method)) {
      throw new Error(`No fake response for ${method}`);
    }
    return this.responses.get(method) as T;
  }

  async close(): Promise<void> {}
}
