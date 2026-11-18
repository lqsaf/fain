// Тонкая обёртка над git. Оркестратор — единственный, кто меняет ветки,
// коммитит и пушит; агент этих прав не имеет.

import { spawnSync } from "node:child_process";
import { ROOT, BRANCH, BASE_BRANCH } from "./config.mjs";

const MAX_BUFFER = 10 * 1024 * 1024;

export function git(args, options = {}) {
  const { allowFailure = false, timeout = 120_000 } = options;
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_BUFFER
  });

  const output = {
    code: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error || null
  };

  if (!allowFailure && (output.code !== 0 || output.error)) {
    const detail = output.stderr || output.error?.message || "unknown git error";
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return output;
}

function lines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function currentBranch() {
  return git(["branch", "--show-current"]).stdout;
}

export function headSha(rev = "HEAD") {
  return git(["rev-parse", rev], { allowFailure: true }).stdout;
}

export function isClean() {
  return git(["status", "--porcelain"]).stdout === "";
}

export function changedFiles() {
  const tracked = lines(git(["diff", "--name-only", "HEAD"]).stdout);
  const staged = lines(git(["diff", "--cached", "--name-only"]).stdout);
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]).stdout);
  return [...new Set([...tracked, ...staged, ...untracked])].sort();
}

export function diffStat() {
  return git(["diff", "--stat", "HEAD"]).stdout;
}

export function branchExists(name) {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFailure: true }).code === 0;
}

export function remoteBranchExists(name) {
  const result = git(["ls-remote", "--heads", "origin", `refs/heads/${name}`], { allowFailure: true, timeout: 60_000 });
  return result.code === 0 && result.stdout.length > 0;
}

export function fetchOrigin() {
  git(["fetch", "--prune", "origin"], { timeout: 120_000 });
}

export function mergeBase(base = BASE_BRANCH) {
  const result = git(["merge", "--no-edit", `origin/${base}`], { allowFailure: true, timeout: 180_000 });
  if (result.code !== 0) {
    git(["merge", "--abort"], { allowFailure: true });
    throw new Error(`merge origin/${base} failed (conflict?): ${result.stderr || result.stdout}`);
  }
}

export function resetToBase(work = BRANCH, base = BASE_BRANCH) {
  git(["checkout", "-B", work, `origin/${base}`]);
}

/**
 * Приводит рабочее дерево к рабочей ветке.
 * - merged reset делает вызывающий код через resetToBase.
 * - локальная ветка переиспользуется и подтягивает base merge-коммитом.
 */
export function ensureWorkBranch(work = BRANCH, base = BASE_BRANCH) {
  if (!isClean()) throw new Error("worktree is dirty; FA requires a clean tree");
  fetchOrigin();

  const current = currentBranch();
  const local = branchExists(work);
  const remote = remoteBranchExists(work);

  if (current === work) {
    mergeBase(base);
    return { branch: work, created: false };
  }

  if (local) {
    git(["checkout", work]);
    mergeBase(base);
    return { branch: work, created: false };
  }

  if (remote) {
    git(["checkout", "-B", work, `origin/${work}`]);
    mergeBase(base);
    return { branch: work, created: false };
  }

  git(["checkout", "-B", work, `origin/${base}`]);
  return { branch: work, created: true };
}

export function revertWorktree() {
  git(["reset", "--hard", "HEAD"], { allowFailure: true });
  git(["clean", "-fd"], { allowFailure: true });
}

export function commitAll(message, body = []) {
  git(["add", "-A"]);
  const args = [
    "-c",
    "user.name=FA",
    "-c",
    "user.email=fa@users.noreply.github.com",
    "commit",
    "-m",
    message
  ];
  for (const line of body.filter(Boolean)) args.push("-m", line);
  git(args);
  return headSha();
}

export function pushWork(work = BRANCH) {
  return git(["push", "origin", `HEAD:refs/heads/${work}`], { timeout: 180_000 });
}

export function behindBase(base = BASE_BRANCH) {
  const result = git(["rev-list", "--count", `HEAD..origin/${base}`], { allowFailure: true });
  return Number(result.stdout || "0");
}
