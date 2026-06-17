import { platform } from "node:os";

export interface EnvironmentInfo {
  cwd: string;
  date: string;
  model: string;
  platform: string;
}

export function formatEnvironmentBlock(info: EnvironmentInfo): string {
  return [
    "<environment>",
    `cwd: ${info.cwd}`,
    `date: ${info.date}`,
    `model: ${info.model}`,
    `platform: ${info.platform}`,
    "</environment>",
  ].join("\n");
}

export function currentEnvironmentInfo(cwd: string, model: string, now = new Date()): EnvironmentInfo {
  return {
    cwd,
    date: now.toISOString().slice(0, 10),
    model,
    platform: platform(),
  };
}
