import { createServer, type Server } from "node:http";
import { URL } from "node:url";

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export interface OAuthCallbackServer {
  redirectUrl: URL;
  waitForCode: Promise<OAuthCallbackResult>;
  close: () => void;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Orin MCP</title></head>
<body style="font-family:system-ui;margin:2rem">
<h1>Authentication complete</h1>
<p>You can close this tab and return to Orin.</p>
</body></html>`;

/** Local loopback server to receive OAuth authorization codes. */
export function startOAuthCallbackServer(pathname = "/callback"): Promise<OAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveCode!: (value: OAuthCallbackResult) => void;
    let rejectCode!: (reason: Error) => void;
    const waitForCode = new Promise<OAuthCallbackResult>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== pathname) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        if (!settled) {
          settled = true;
          rejectCode(new Error(description));
        }
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h1>Authentication failed</h1><p>${description}</p></body></html>`);
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("Missing authorization code");
        return;
      }

      if (!settled) {
        settled = true;
        resolveCode({ code, state: url.searchParams.get("state") ?? undefined });
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind OAuth callback server"));
        return;
      }
      const redirectUrl = new URL(`http://127.0.0.1:${addr.port}${pathname}`);
      resolve({
        redirectUrl,
        waitForCode,
        close: () => {
          if (!settled) {
            settled = true;
            rejectCode(new Error("OAuth callback cancelled"));
          }
          server.close();
        },
      });
    });
  });
}
