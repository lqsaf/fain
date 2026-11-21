# FA Harness Audit Report

**Date**: 2026-11-21  
**Scope**: Full harness audit + reliability/model-routing changes  
**Status**: Audit findings and follow-up implementation status are tracked below. Recommendations that require repository-owner configuration remain explicitly marked.

---

## 1. Implementation Update (2026-11-21)

The following changes supersede the original snapshot and recommendations below:

- The code-role order is explicit and non-duplicated: Nemotron Super VL leads planning; Nemotron Ultra leads execution, repair and reviewer. DeepSeek V4.1 Flash was absent from the live NVIDIA `/v1/models` catalogue and has been removed. Each role retains the same Google fallback order: Gemini 4 Hydrogen → 3.8 Flash → 3.6 Flash → 2.5 Flash. The simple non-coding route remains Nemotron Lightning → Gemini 3.5 Flash-Lite → 3.1 Flash-Lite. No unused model blacklist is maintained.
- Live catalogue check against `https://integrate.api.nvidia.com/v1/models` confirmed the configured NVIDIA API IDs are listed: `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3.5-super-vl-120b-a12b`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `z-ai/glm-5.3-flash`, `minimaxai/minimax-m3.1-flash` and `poolside/laguna-xs-2.1`. `deepseek-ai/deepseek-v4.1-flash` was absent. Catalogue presence confirms registration only, not successful inference for a particular account.
- Standard Google quotas are 5 RPM / 250000 TPM / 20 RPD; Flash-Lite quotas are 15 RPM / 250000 TPM / 500 RPD. The router enforces request, token and shared daily quota groups.
- Default model/task/run budgets are 60/90/240 minutes; repair phases are capped at 30 minutes; the hourly FA workflow allows 285 minutes.
- The latest observed FA run (#99) selected `nvidia/step-5-preview` and timed out on T04 after about 1016 seconds ([run #99](https://github.com/lqsaf/fain/actions/runs/44917990306)). At that run's commit, `models.mjs` included Step 5 in all coding roles and only prioritized by provider, confirming the broken model could be selected from the default registry. The workflow also allowed optional repository overrides; scheduled runs now use curated routes and code-owned timeout defaults.
- Model-registry, OpenCode config, evaluator, runner and agent-prompt changes trigger evaluation in `fa-verify`; `fa:doctor --probe-capabilities` explicitly evaluates configured models and records latency, success, and token metrics without changing route order.
- Changes to routing config/loop are included in evaluation detection; external PRs that change models or prompts fail closed until a maintainer runs the provider-backed workflow from a trusted repository branch containing the diff.
- Structured records carry trace/span IDs. Model and tool calls produce OTLP spans, saved to `traces.otlp.json` and optionally sent to an OTLP/HTTP endpoint without prompt or tool arguments.
- Run summaries track reported model cost and flag runs over twice the median of up to 30 previous measured runs. Failures are tagged by ETCLOVG layer in logs and blocked-issue bodies.
- T04 is decomposed into an accordion task and four dependent dropdown, keyboard, accessibility/lifecycle, and CSS-isolation tasks.
- A quarterly reminder issue reviews scaffolding, timeouts, cost, privacy, and model probes. A reusable harness adaptation guide is available in `docs/harness/TEMPLATE.md`.
- The MCP API publishes a versioned registry at `fa://tool-registry`; CODEOWNERS covers harness, workflow, Worker and Wrangler changes. GitHub must still be configured to require Code Owner approval for those paths.

---

## 2. ETCLOVG Audit: Current State vs. Best Practices

Based on the **ETCLOVG** taxonomy (Execution, Tooling, Context, Lifecycle, Observability, Verification, Governance) from the "Prompt Engineering Is Dead" video / TrueFoundry survey.

### ✅ E — Execution Environment (Strong)
- **GitHub Actions ubuntu-latest** with Node 22, pinned OpenCode version
- **Hard limits in code**: `FA_TASK_TIMEOUT_MIN=90`, `FA_RUN_BUDGET_MIN=240`, `FA_MAX_ATTEMPTS=2`, `FA_TOKEN_BUDGET=2M`, `steps=60` in agent
- **Concurrency control**: `fa-loop` group prevents parallel runs
- **Sandbox isolation**: `external_directory` denied, no `.env`/secrets access, no `webfetch`/`websearch`, no package installs/deploys
- **Kill switches**: `FA_ENABLED=false`, `FA_STOP` file, `workflow_dispatch mode=stop`

### ✅ T — Tooling & Protocol (Strong)
- **MCP server** (`scripts/fa/mcp-server.mjs`) exposes deterministic tools: queue, verify, diff, context, memory
- **Tool allowlist** in `scripts/fa/policy.mjs` — agent cannot access arbitrary tools
- **Structured tool contracts** with error schemas

### ✅ C — Context & Memory (Strong)
- **Layered context**: short (task prompt), session (step history), persistent (`AGENTS.md`, `CONVENTIONS.md`, skill `fain`, `TASKS.md`)
- **Compaction configured** in `opencode.jsonc`: auto, keep 12K tokens, 10% buffer
- **MCP tools** for context retrieval instead of stuffing repo into prompt
- **I18N parity checks** in verify prevent context drift across languages

### ✅ L — Lifecycle & Orchestration (Strong)
- **State machine**: gate → pick task → `opencode run --agent fa` → verify + diff guard → commit to `fa/work` → PR → human merge
- **One task per run** enforced by code
- **Rollback on failure**: working tree reset, attempt counter, `[!]` after limit
- **Watchdog cron** (`0 * * * *`) only starts if queue non-empty and no stop signal
- **No state holes**: progress only in commits and `TASKS.md` (orchestrator-owned)

### ⚠️ O — Observability (Partial — **Main Gap**)
| Capability | Status | Gap |
|------------|--------|-----|
| JSONL event logs | ✅ `fa/logs/<run>/run.jsonl`, `<task>.jsonl` | Good |
| Stderr capture | ✅ `<task>.err.log` | Good |
| Token/cost tracking | ✅ `metrics.mjs`, `summary.json` | Good |
| **Per-step traces with model/tool/sandbox metadata** | ❌ | Only coarse-grained; no OpenTelemetry export |
| **Unified observability stack** | ❌ | Logs are local files uploaded as artifacts; no live dashboard |
| **Failure attribution to layer** | ❌ | No automated ETCLOVG-layer tagging of failures |
| **Alerting on patterns** | ⚠️ | Only issue creation on 3 infra failures / blocked tasks |

**Recommendation**: Add OpenTelemetry export from `scripts/fa/loop.mjs` and `mcp-server.mjs`; connect to a tracing backend (Grafana Tempo, Jaeger, or commercial). This is the #1 actionable gap per the survey — observability is "comparatively thin in open source."

### ⚠️ V — Verification (Partial)
| Capability | Status | Gap |
|------------|--------|-----|
| Level 1: Code invariants | ✅ `npm run verify` (13 checks) | Strong |
| Level 2: Model eval | ✅ `npm run fa:eval -- --suite model` | Exists but baseline empty |
| Level 3: Human review | ✅ PR merge + `fa-reviewer` subagent | Good |
| **Deployment-time evaluation** | ❌ | Eval runs manually/on-demand, not in promotion gate |
| **Regression detection on model change** | ⚠️ | Requires manual `fa:eval` run; not automated in workflow |
| **Trace-grounded evaluation** | ❌ | Evaluator cannot access per-step traces |

**Recommendation**: Add `fa:eval` as a required check in `fa.yml` before PR merge (or as a nightly scheduled job). Connect evaluator to O-layer traces.

### ✅ G — Governance (Strong)
- **Hard deny policies** in `opencode.jsonc`: no secrets read/edit, no irreversible git/deploy/publish, no `sudo`/`rm -rf`
- **Agent cannot modify harness**: protected paths in `scripts/fa/policy.mjs`, verified pre/post agent
- **Human-only actions**: merge, deploy, secret rotation, data migration
- **Branch protection**: `main` requires PR + `fa-verify` check, no force-push
- **Credential model**: GitHub Secrets only, rotated per-provider, never logged
- **Audit trail**: all runs produce `summary.json`, `run.jsonl`, PR history

---

## 3. Specific Improvements (Prioritized)

### P0 — Critical (Blocking Reliability)

1. **Add OpenTelemetry tracing** (Observability)
   - Export per-step traces: model call, tool call, sandbox exec, token usage, latency
   - Enable failure attribution to ETCLOVG layer
   - Integrate with existing `metrics.mjs` infrastructure

2. **Automate model eval in CI** (Verification)
   - Add `npm run fa:eval -- --suite model` as required check in `fa-verify.yml` or nightly workflow
   - Fail if pass rate drops below baseline
   - Store baseline in `PROMPTS.md` (currently empty)

3. **Fix T04 timeout root cause**
   - T04 (settings accordion + inline dropdowns) timed out 28× (issues #36–#58)
   - Actions run #99 selected `nvidia/step-5-preview`; its source revision included that failing model in the default registry for every coding role and had provider-only ordering. This confirms a routing defect, but does not prove that the selected model alone caused the 1016-second T04 timeout; task-level trace details are still needed to establish the execution root cause.
   - **Mitigation**: remove workflow pass-through of repository model/timeout overrides, split T04 into five bounded tasks and raise code defaults. Validate against the next runs rather than claiming the historical timeout root cause is fully proven.

### P1 — High (Operational Risk)

4. **Add per-step structured logging with correlation IDs**
   - Currently `run.jsonl` has events but no trace ID linking model→tool→sandbox
   - Add `trace_id` and `span_id` to every log entry

5. **Implement deployment-time evaluation gate**
   - Before `fa/work → main` merge, run eval on changed files
   - Block merge if eval regresses (configurable threshold)

6. **Add cost anomaly detection**
   - `metrics.mjs` tracks tokens; add alert if single run > 2× median
   - Prevent runaway loops from burning budget

### P2 — Medium (Harness Maturity)

7. **Standardize failure taxonomy with ETCLOVG tags**
   - Extend `classifyFailure` in `models.mjs` to return layer: `E|T|C|L|O|V|G`
   - Auto-tag issues with layer for faster triage

8. **Add adaptive simplification hooks**
   - Per survey: "every wrapper encodes an assumption about what the model can't do reliably alone"
   - Add periodic audit (quarterly) to remove obsolete scaffolding
   - Example: if model handles context well, reduce compaction aggressiveness

9. **Improve task decomposition for complex UI tasks**
   - T04 acceptance criteria: 15 detailed requirements in one task
   - Split into: T04a (accordion), T04b (inline dropdown), T04c (keyboard), T04d (accessibility), T04e (CSS editor isolation)
   - Smaller tasks = faster feedback, less timeout risk

10. **Add model capability probes to preflight**
    - `npm run fa:doctor -- --probe-capabilities` runs deterministic coding or simple-task probes on configured models
    - Record latency, success rate, token efficiency
    - Keep route order human-reviewed; automatic reordering would override provider priorities and can spend scarce Google daily quota

### P3 — Nice to Have

11. **MCP tool registry with versioning**
    - Current MCP server is monolithic; split into versioned tools
    - Enable rolling updates without breaking agent compatibility

12. **Human-in-the-loop approval gate for sensitive actions**
    - Already have PR review; add explicit approval for `fa/work` commits that touch security/config files

13. **Cross-repo harness template**
    - Extract FA harness as reusable template for other projects
    - Document in `docs/harness/TEMPLATE.md`

---

## 4. Cross-Layer Coupling Risks (Per Survey)

| Change | Coupling Risk | Mitigation |
|--------|---------------|------------|
| Nemotron as primary executor | May change token usage pattern → affects `FA_TOKEN_BUDGET` and rate limits | Monitor first 10 runs; adjust budget if needed |
| Increased task timeout | Longer runs → more tokens → higher cost | Add cost anomaly alert (P1 #6) |
| Splitting T04 | More tasks → more runs → more API calls | Batch related tasks in single run if queue allows |
| Adding OTEL tracing | Extra latency per step | Use async export; batch spans |

---

## 5. Verification Checklist (Post-Change)

Run these after deploying the Nemotron change:

```bash
# 1. Invariants (must pass)
npm run verify

# 2. Preflight (catalogue/credentials only; no model calls)
npm run fa:preflight

# 2a. Optional, quota-consuming capability evaluation
npm run fa:doctor -- --probe-capabilities

# 3. Model eval (establish Nemotron baseline)
npm run fa:eval -- --suite model --models nvidia/nemotron-3-ultra-550b-a55b,google/gemini-4-hydrogen,google/gemini-3.1-flash-lite

# 4. Local test run (if keys available)
export GEMINI_API_KEY="..."
export NVIDIA_API_KEY="..."
npm run fa -- --force-local --once

# 5. Check GitHub Actions
# - Trigger workflow_dispatch with mode=once
# - Verify run completes, PR opens, fa-verify passes
```

---

## 6. Summary

| Item | Status |
|------|--------|
| Nemotron 3 Ultra as primary executor | ✅ Done |
| Documentation updated | ✅ Done |
| Verify assertions updated | ✅ Done |
| Baseline schema documented; actual evaluation baseline | ⚠️ Pending a successful provider-backed run |
| **Observability (OTEL model/tool spans)** | ✅ Implemented; verify in a live run |
| **Automated model eval in CI** | ✅ Implemented for route/config changes; measured baseline still pending |
| **Model/prompt merge-time evaluation gate** | ✅ Conditional eval check; owner must require its status in branch protection |
| **T04 timeout mitigation** | ✅ Decomposed and increased budgets; historical cause still unconfirmed |
| Cost anomaly detection | ✅ Implemented |
| ETCLOVG failure tagging | ✅ Implemented in logs and blocked issues |
| Quarterly simplification review | ✅ Reminder workflow implemented |
| Model capability probes | ✅ Explicit opt-in probe implemented; no automatic route rewriting |
| MCP registry versioning | ✅ `fa://tool-registry` v1 |
| Sensitive-file approval | ✅ CODEOWNERS coverage; branch-protection setting must be enabled in GitHub |
| Cross-repo harness template | ✅ `docs/harness/TEMPLATE.md` |

The harness has code-level implementations for the listed improvements. Remaining confirmation depends on running verification/model probes, observing the decomposed T04 tasks, recording real evaluation baselines, and enabling Code Owner review in GitHub branch protection. None of those runtime/external outcomes is claimed from repository changes alone.