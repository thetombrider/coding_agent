import type { Server } from "node:http";
import { createServer } from "node:http";

export interface LoopbackCallback {
  code: string;
  state?: string;
}

export interface LoopbackOAuthServer {
  redirectUri: string;
  waitForCallback: (timeoutMs?: number) => Promise<LoopbackCallback>;
  close: () => void;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Orin — authenticated</title></head>
<body><h1>Authentication successful</h1><p>You can close this tab and return to Orin.</p></body></html>`;

/** Bind an ephemeral localhost server for OAuth redirect capture. */
export function startLoopbackOAuthServer(): Promise<LoopbackOAuthServer> {
  return new Promise((resolve, reject) => {
    let port = 0;
    let pendingResolve: ((value: LoopbackCallback) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);

      if (timer) clearTimeout(timer);
      pendingResolve?.({
        code,
        state: url.searchParams.get("state") ?? undefined,
      });
      pendingResolve = null;
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to bind loopback OAuth server"));
        return;
      }
      port = address.port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      resolve({
        redirectUri,
        waitForCallback(timeoutMs = 120_000) {
          return new Promise<LoopbackCallback>((res, rej) => {
            pendingResolve = res;
            timer = setTimeout(() => {
              pendingResolve = null;
              rej(new Error("OAuth loopback callback timed out"));
            }, timeoutMs);
          });
        },
        close() {
          if (timer) clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}
