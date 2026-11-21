# Reusing the FA harness

This repository is a reference implementation, not a drop-in template. A fork must adapt its repository contract before enabling scheduled execution.

## Required project inputs

1. Define the task source and its ownership. Keep task acceptance separate from harness policy.
2. Identify allowed write paths, protected paths, secret paths, and irreversible actions.
3. Add deterministic verification commands for syntax, data contracts, and repository-specific invariants.
4. Declare model providers, role-specific order, per-provider limits, and safe fallback behavior.
5. Set task, phase, run, token, and CI timeouts from measured workload rather than copying defaults.
6. Configure a human-owned target branch, pull-request workflow, branch protection, code-owner review, and kill switch.
7. Decide what telemetry is retained, whether an OTLP endpoint is permitted, and how public artifacts are scrubbed.

## Adaptation sequence

1. Copy only the dependency-free modules required by the target project; do not copy this repository's application code or backlog.
2. Replace repository paths and task parsing with the target contract.
3. Remove unsupported providers and tools from the model registry and agent permissions.
4. Create deterministic self-tests for routing, quotas, state transitions, and protected paths.
5. Run invariant checks locally before adding provider credentials.
6. Run a small, explicitly approved model evaluation and record its actual baseline.
7. Enable the CI verification gate and require code-owner approval for policy, workflow, and security-sensitive changes.
8. Enable scheduled runs only after a successful manual dry run and review of the uploaded logs.

## Invariants for a fork

- Never place credentials or private content in the task source or logs.
- Every model role has an explicit ordered route, quota enforcement, and a tested failure path.
- Evaluation never uses a coding prompt for a model restricted to simple non-coding tasks.
- A successful model fallback must not be reported as a failed task solely because an earlier model timed out.
- The agent cannot modify its own policy, verifier, workflow, or task queue.
- Scheduled automation creates reviewable changes on a non-default branch; merge and deployment remain human-controlled.
- Traces omit prompts, tool arguments, secret values, and raw provider error bodies.
- Each run has a hard deadline, token budget, concurrency limit, and human-operated stop control.

## Repository-specific work

Do not copy the following as-is: `TASKS.md`, repository-specific `verify` rules, `opencode.jsonc`, `.github` secrets/permissions, branch names, model IDs, provider quotas, task prompts, or UI smoke fixtures. Revalidate every path and permission against the fork's threat model before enabling an agent.
