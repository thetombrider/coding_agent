import { spawn } from "node:child_process";

/** Open a URL in the user's default browser (best-effort). */
export function openBrowser(url: string | URL): void {
  const target = String(url);
  const cmd =
    process.platform === "darwin"
      ? { file: "open", args: [target] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", target] }
        : { file: "xdg-open", args: [target] };

  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" });
  child.unref();
}
