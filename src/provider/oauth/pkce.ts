import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url").replace(/=+$/, "");
}

/** Generate a PKCE code_verifier and S256 code_challenge. */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Parse a pasted OAuth callback payload (`code` or `code#state`). */
export function parseOAuthCallbackInput(raw: string): { code: string; state?: string } {
  const trimmed = raw.trim();
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx === -1) return { code: trimmed };
  return {
    code: trimmed.slice(0, hashIdx),
    state: trimmed.slice(hashIdx + 1) || undefined,
  };
}
