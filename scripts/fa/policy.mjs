// Shared FA policy: protected paths, allowed verification commands, secret patterns.
// This module is dependency-free and side-effect free.

export const PROTECTED_GLOBS = [
  ".github/workflows/fa.yml",
  ".github/workflows/fa-verify.yml",
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
  ".githooks/**",
  "opencode.jsonc",
  ".opencode/**",
  "scripts/fa/**",
  "scripts/verify.mjs",
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  ".gitignore",
  "docs/harness/**",
  "docs/decisions/**",
  "fa/state.json",
  "TASKS.md"
];

export const ALLOWED_VERIFY_PREFIXES = ["node ", "npm run ", "node --check "];

export const SECRET_PATTERNS = [
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github-fine-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

/** Convert a glob with `**`, `*` and `?` into an anchored RegExp. */
export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function isProtected(file) {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_GLOBS.some((glob) => globToRegExp(glob).test(normalized));
}

export function isAllowedVerifyCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  if (trimmed.includes("\n") || /[;&|`$><]/.test(trimmed)) return false;
  return ALLOWED_VERIFY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function findSecrets(text) {
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const match = text.match(re);
    if (match) hits.push({ name, sample: redact(match[0]) });
  }
  return hits;
}

export function redact(value) {
  const text = String(value);
  if (text.length <= 8) return "[redacted]";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
