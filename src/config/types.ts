import type { TriageRole } from './triage-labels.js';

/** Supported agent CLI providers. */
export const AGENT_CLIS = ['cursor', 'claude-code', 'codex', 'copilot'] as const;
export type AgentCli = (typeof AGENT_CLIS)[number];

/**
 * The per-issue pipeline stages — also the values of the `lastStage` resume
 * checkpoint (re-exported as `Stage` from issues/resolve-resume-stage.ts).
 */
export const PIPELINE_STAGE_NAMES = ['implement', 'verifyFix', 'review', 'reviewFix'] as const;
export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];

/**
 * Every kind of agent session loop runs: the pipeline stages plus goal mode's
 * `plan` and `evaluate`. All six are keys of the per-stage `stages` config object.
 */
export const STAGE_NAMES = [...PIPELINE_STAGE_NAMES, 'plan', 'evaluate'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** Per-stage agentCli/model/effort override. An omitted field falls back to the top-level value. */
export type StageAgentOverride = {
  agentCli?: AgentCli;
  model?: string;
  /** Reasoning intensity — Claude `--effort`, Codex `model_reasoning_effort`, Copilot `--effort`; unsupported on cursor. */
  effort?: string;
};

/** One ordered provider fallback in the chain activated when the primary CLI hits a usage limit. */
export type FallbackAgentConfig = {
  agentCli: AgentCli;
  /** Omitted = let the fallback CLI choose its default model. */
  model?: string;
  /** Omitted = let the fallback CLI choose its default reasoning effort. */
  effort?: string;
};

/** The signals worth walking away from a run for — deliberately no progress/heartbeat events. */
export const WEBHOOK_EVENT_NAMES = [
  'issue-completed',
  'issue-escalated',
  'run-completed',
  'fix-nits-completed',
  'polish-completed',
  'goal-completed',
  'usage-limit',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENT_NAMES)[number];

/** Goal-mode defaults (see commands/goal.ts). */
export type GoalConfig = {
  /** Hard cap on new issues a single plan session may create. */
  maxIssuesPerRound: number;
  /** Rounds per invocation; null = unlimited (loop warns when neither this nor --budget bounds a run). */
  roundLimit: number | null;
  /** Max replacements per escalated-issue lineage before the goal blocks. */
  supersedeLimit: number;
  /** Goal-mode usage-limit policies; unset scopes fall back to the top-level `usageLimits`. */
  usageLimits: Partial<UsageLimitsConfig>;
};

export type WebhookConfig = {
  /** Endpoint URL. `${ENV_VAR}` references resolve from the environment at send time. */
  url: string;
  /** Event subset filter; omitted = every event. */
  events?: WebhookEventName[];
  /** `generic` posts the full JSON event; `slack` posts `{ text }` for incoming webhooks. */
  format?: 'generic' | 'slack';
  /** Extra headers; values support `${ENV_VAR}` references. */
  headers?: Record<string, string>;
};

/**
 * Per-project overrides, keyed by the project folder name under `issuesDir`
 * (including the date prefix for a dated spec project).
 * A project groups related work (multiple features/fixes — e.g. one spec);
 * in a monorepo different projects verify different packages.
 */
export type ProjectOverride = {
  /**
   * Verify command for this project's issues. Wins over the global `verifyCmd`
   * (including a `--verify-cmd` flag — per-project is the more specific
   * setting); the global remains required as the fallback.
   */
  verifyCmd?: string;
  /**
   * Model for this project's sessions. Beaten by a per-stage `stages.<stage>.model`:
   * that states something about a *kind of work* which holds across projects, so a
   * project default must not silently undo it.
   */
  model?: string;
  /** Reasoning effort for this project's sessions; same precedence as `model`. */
  effort?: string;
  /** Environment for this project's sessions and verify runs; merged over the global `env`, key by key. */
  env?: Record<string, string>;
  /** Readiness probe for this project; replaces the global `preflight` outright. */
  preflight?: PreflightConfig;
  /** Whether this project's sessions may replace `verifyCmd` for one issue (see `allowDeclaredVerify`). */
  allowDeclaredVerify?: boolean;
  /** spec doc for this project's prompts: a repo-relative path, or a filename prefix within `specsDir`. Issue-level `spec:` frontmatter still wins. */
  spec?: string;
  /** Usage-limit policies for this project's issues; unset scopes fall back to the top-level `usageLimits`. */
  usageLimits?: Partial<UsageLimitsConfig>;
};

/**
 * Retrying a session killed by the provider's own infrastructure (see
 * agent/providers/infra-error.ts). Never applies to usage limits, whose remedy
 * differs in kind, nor to loop's own wall/idle timeouts.
 */
export type AgentRetriesConfig = {
  /** Extra attempts after the first infrastructure failure. `0` disables retrying. */
  attempts: number;
  /** Backoff before the first retry; doubles per attempt, capped by `maxDelayMs`, ±25% jitter. */
  initialDelayMs: number;
  maxDelayMs: number;
};

/**
 * Readiness probe for whatever the verify command depends on — a database, a
 * running service, a built artifact. Loop refuses to keep claiming work when it
 * fails, because every issue would fail for the same reason.
 */
export type PreflightConfig = {
  /** Shell command; a zero exit means ready. Should be cheap — it runs before every claim. */
  cmd: string;
  /** What the operator should do about it, printed with the failure. */
  message: string;
};

/** What to do when a session dies on a provider usage limit, per limit window. */
export type UsageLimitPolicy = 'wait' | 'stop';
export type UsageLimitsConfig = {
  /** Session/5-hour-style windows. Default `wait`: drain, sleep until reset, resume. */
  session: UsageLimitPolicy;
  /** Weekly windows. Default `stop`: a multi-day sleep is rarely what an unattended run should do. */
  weekly: UsageLimitPolicy;
};

/**
 * Fully-resolved loop configuration (defaults applied, env/CLI precedence
 * folded in by load-config.ts). `null` means "unset" for optional features.
 */
export type LoopConfig = {
  /** Global default agent CLI; overridable per-stage via `stages`. */
  agentCli: AgentCli;
  /** Global default model; overridable per-stage via `stages`. */
  model: string;
  /** Global default effort/reasoning intensity; overridable per-stage via `stages`. `null` = CLI default. */
  effort: string | null;
  /** Ordered provider failover chain tried only when the active CLI reports a usage limit. */
  fallbackAgents: FallbackAgentConfig[];
  /** Shell command run after each agent turn. `null` = never set — commands fail fast when they need it. */
  verifyCmd: string | null;
  /**
   * Environment merged over the inherited env for every agent session *and*
   * every verify run, so a command an agent proves by hand behaves identically
   * when loop re-runs it. Also the right home for toolchain hygiene: loop gives
   * every issue its own worktree, so daemon-spawning tools otherwise leak one
   * background process per issue.
   */
  env: Record<string, string>;
  /** Readiness probe run before each claim. `null` = disabled. */
  preflight: PreflightConfig | null;
  /**
   * Whether an implement/fix session may replace `verifyCmd` for the issue it
   * is working on, by declaring one (see verify/declared-verify.ts).
   *
   * Default `true`. What a gate should prove is often not knowable when the
   * gate is configured — a feature grows a service, a package, a migration —
   * and a gate that misses an edited package does not fail loudly, it passes a
   * real break silently. The authority this hands a session is bounded by four
   * fences (prompt framing, the review's side-by-side comparison, the
   * configured command still running post-merge, and an announcement), so the
   * failure mode of being wrong is a blocked review, not a silent pass.
   */
  allowDeclaredVerify: boolean;
  /**
   * Where `loop archive` moves a wrapped-up project's material. Deliberately
   * **no default**: archiving moves real directories, so loop refuses until a
   * repo states where retired planning material belongs.
   */
  archiveDir: string | null;
  /** Issue root, relative to the repo root (or absolute). */
  issuesDir: string;
  maxVerifyCycles: number;
  maxReviewCycles: number;
  agentTimeoutMs: number;
  agentIdleTimeoutMs: number;
  heartbeatIntervalMs: number;
  showThinking: boolean;
  worktreeEnabled: boolean;
  /**
   * Hold a system sleep inhibitor for the whole invocation (macOS `caffeinate
   * -i`, tied to loop's pid). Default `true`: an unattended run that sleeps two
   * hours in is as lost as one that sleeps through a usage-limit wait.
   */
  keepAwake: boolean;
  /** Skill directive for review prompts (e.g. "/review-work"). `null` = omit from prompts. */
  reviewSkill: string | null;
  /** Skill directive for implement prompts (e.g. "/tdd"). `null` = omit from prompts. */
  tddSkill: string | null;
  /** Pathspecs excluded from staging ("stage everything, exclude these"). Empty = stage everything. */
  commitExcludePaths: string[];
  /**
   * How much the sandbox running agent commands may reach. Ordered by
   * privilege, and what each buys measured against a Mongo + Vite + Chromium
   * gate:
   *
   * - `read-only` — inspection only; an agent cannot even write the workspace.
   * - `workspace-write` (default) — writes the workspace, but blocks Docker,
   *   every `localhost` connection and any port bind. An agent cannot start
   *   MongoDB, run a Mongo-backed suite, boot Vite or launch Chromium; it can
   *   only report that verification was impossible, and loop then declines to
   *   accept coverage nothing proved.
   * - `workspace-write` **plus `sandboxNetworkAccess`** — adds Docker and
   *   loopback. Enough for service-backed unit and HTTP suites.
   * - `danger-full-access` — no sandbox. Additionally allows launching a
   *   browser (Chromium needs Mach-port registration, which seatbelt refuses
   *   at every lower level) and writing `.git`, so an agent can commit its own
   *   work instead of relying on loop's fallback commit.
   *
   * Raise this only as far as the repo's gate actually needs: at
   * `danger-full-access` agent-generated commands run unsandboxed.
   */
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Add network and Docker reach to a `workspace-write` sandbox. Ignored at the
   * other modes: `read-only` has no use for it and `danger-full-access`
   * already implies it.
   */
  sandboxNetworkAccess: boolean;
  /** Dependency install command for worktree sync. `null` = auto-install disabled. */
  installCmd: string | null;
  /** Files whose changes trigger `installCmd` during worktree sync. */
  dependencyFiles: string[];
  /** Directory for implicit spec lookup. `null` disables lookup; explicit spec pointers still work. */
  specsDir: string | null;
  /** Raw (possibly partial) role → label overrides; resolve via resolveTriageLabels(). */
  triageLabels: Partial<Record<TriageRole, string>>;
  maxParallelRuns: number;
  /** Per-stage agentCli/model overrides. Omitted stages/fields fall back to top-level. */
  stages: Partial<Record<StageName, StageAgentOverride>>;
  /** Per-project verifyCmd/spec overrides, keyed by project folder name. Empty = global settings everywhere. */
  projects: Record<string, ProjectOverride>;
  /** Outbound notifications for completion/escalation signals. Empty = disabled. */
  webhooks: WebhookConfig[];
  /** Usage-limit handling per limit window (see notify/usage-limit wait in commands/run.ts). */
  usageLimits: UsageLimitsConfig;
  /** In-place retry policy for sessions killed by provider infrastructure faults. */
  agentRetries: AgentRetriesConfig;
  /** Goal-mode settings (`loop goal`). */
  goal: GoalConfig;
};
