import type { JsonRpcClient } from "./types.js";
export declare class StdioAppServerClient implements JsonRpcClient {
    private readonly proc;
    private readonly lines;
    private nextId;
    private pending;
    private notificationHandlers;
    private constructor();
    static create(command?: string, args?: string[]): Promise<StdioAppServerClient>;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): void;
    onNotification(handler: (method: string, params: unknown) => void): void;
    close(): Promise<void>;
    private handleLine;
}
