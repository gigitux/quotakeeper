import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcClient } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class StdioAppServerClient implements JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];

  private constructor(
    private readonly proc: ChildProcessByStdio<Writable, Readable, null>,
    private readonly lines: Interface,
  ) {
    this.lines.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", (code, signal) => {
      const error = new Error(
        `codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static async create(command = "codex", args = ["app-server"]): Promise<StdioAppServerClient> {
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: proc.stdout });
    const client = new StdioAppServerClient(proc, lines);
    await client.request("initialize", {
      clientInfo: {
        name: "quota-keeper",
        title: "QuotaKeeper",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    client.notify("initialized", {});
    return client;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    const message = params === undefined ? { method } : { method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.lines.close();
    if (!this.proc.killed) {
      this.proc.kill();
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number };
      method?: string;
      params?: unknown;
    };

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`.trim()),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params);
      }
    }
  }
}
