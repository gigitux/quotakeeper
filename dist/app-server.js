import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class StdioAppServerClient {
    proc;
    lines;
    nextId = 1;
    pending = new Map();
    notificationHandlers = [];
    constructor(proc, lines) {
        this.proc = proc;
        this.lines = lines;
        this.lines.on("line", (line) => this.handleLine(line));
        this.proc.on("exit", (code, signal) => {
            const error = new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
            for (const pending of this.pending.values()) {
                pending.reject(error);
            }
            this.pending.clear();
        });
    }
    static async create(command = "codex", args = ["app-server"]) {
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
    request(method, params) {
        const id = this.nextId++;
        const message = params === undefined ? { id, method } : { id, method, params };
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject });
        });
    }
    notify(method, params) {
        const message = params === undefined ? { method } : { method, params };
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    }
    onNotification(handler) {
        this.notificationHandlers.push(handler);
    }
    async close() {
        this.lines.close();
        if (!this.proc.killed) {
            this.proc.kill();
        }
    }
    handleLine(line) {
        if (!line.trim()) {
            return;
        }
        const message = JSON.parse(line);
        if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`.trim()));
            }
            else {
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
//# sourceMappingURL=app-server.js.map