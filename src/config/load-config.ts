/**
 * Loads `loop.config.json` from the target repo root and folds in env vars
 * and CLI flags with precedence: CLI flag > env var > config file > built-in
 * default. Invalid JSON or an unknown/mis-typed shape throws a descriptive
 * Error (the CLI entry point routes it through failStop).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AGENT_CLIS,
  STAGE_NAMES,
  WEBHOOK_EVENT_NAMES,
  type AgentCli,
  type AgentRetriesConfig,
  type FallbackAgentConfig,
  type GoalConfig,
  type LoopConfig,
  type PreflightConfig,
  type ProjectOverride,
  type StageAgentOverride,
  type StageName,
  type UsageLimitPolicy,
  type UsageLimitsConfig,
  type WebhookConfig,
  type WebhookEventName,
} from './types.js';
import { TRIAGE_ROLES, type TriageRole } from './triage-labels.js';

export const CONFIG_FILE_NAME = 'loop.config.json';

/**
 * Machine-local overlay, read *over* the tracked config. A project entry often
 * names an in-progress branch, a machine-specific command and a local PRD path
 * — temporary, and belonging to whoever runs loop — so a repo can commit its
 * shared settings and keep those out of git. Nested objects merge one level
 * deep (a `projects` entry here adds to the tracked map rather than replacing
 * the whole map); everything else is replaced outright.
 */
export const LOCAL_CONFIG_FILE_NAME = 'loop.config.local.json';

/** Tracked reference file `loop init` writes; kept honest by a drift test. */
export const EXAMPLE_CONFIG_FILE_NAME = 'loop.config.example.json';

export const DEFAULT_CONFIG: LoopConfig = {
  agentCli: 'cursor',
  model: 'auto',
  effort: null,
  fallbackAgents: [],
  verifyCmd: null,
  env: {},
  preflight: null,
  allowDeclaredVerify: true,
  archiveDir: null,
  issuesDir: 'issues',
  maxVerifyCycles: 3,
  maxReviewCycles: 3,
  agentTimeoutMs: 2 * 60 * 60 * 1000,
  agentIdleTimeoutMs: 20 * 60 * 1000,
  heartbeatIntervalMs: 60 * 1000,
  showThinking: true,
  worktreeEnabled: true,
  keepAwake: true,
  reviewSkill: null,
  tddSkill: null,
  commitExcludePaths: [],
  installCmd: null,
  dependencyFiles: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  prdsDir: null,
  triageLabels: {},
  maxParallelRuns: 1,
  stages: {},
  projects: {},
  webhooks: [],
  usageLimits: { session: 'wait', weekly: 'stop' },
  agentRetries: { attempts: 2, initialDelayMs: 15_000, maxDelayMs: 180_000 },
  goal: { maxIssuesPerRound: 5, roundLimit: null, supersedeLimit: 3, usageLimits: {} },
};

/**
 * CLI-flag overrides for config-backed fields. Highest precedence. Note that
 * `agentCli`/`model` passed here override the *top-level* config values only —
 * per-stage resolution (which lets a `--agent-cli`/`--model` flag beat
 * `stages.<stage>` overrides too) additionally takes the raw flags via
 * `resolveStageAgentSettings(config, cliFlags, stage)`.
 */
export type ConfigCliOverrides = {
  agentCli?: AgentCli;
  model?: string;
  effort?: string;
  verifyCmd?: string;
  issuesDir?: string;
  maxVerifyCycles?: number;
  maxReviewCycles?: number;
  agentTimeoutMs?: number;
  agentIdleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  showThinking?: boolean;
  worktreeEnabled?: boolean;
  keepAwake?: boolean;
  maxParallelRuns?: number;
};

export type ConfigEnv = Record<string, string | undefined>;

const KNOWN_KEYS = new Set<string>([
  'agentCli',
  'model',
  'effort',
  'fallbackAgents',
  'verifyCmd',
  'env',
  'preflight',
  'allowDeclaredVerify',
  'archiveDir',
  'issuesDir',
  'maxVerifyCycles',
  'maxReviewCycles',
  'agentTimeoutMs',
  'agentIdleTimeoutMs',
  'heartbeatIntervalMs',
  'showThinking',
  'worktreeEnabled',
  'keepAwake',
  'reviewSkill',
  'tddSkill',
  'commitExcludePaths',
  'installCmd',
  'dependencyFiles',
  'prdsDir',
  'triageLabels',
  'maxParallelRuns',
  'stages',
  'projects',
  'webhooks',
  'usageLimits',
  'agentRetries',
  'goal',
]);

function configError(message: string): Error {
  return new Error(`${CONFIG_FILE_NAME}: ${message}`);
}

function expectString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw configError(`"${key}" must be a non-empty string`);
  }
  return value;
}

function expectNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw configError(`"${key}" must be a positive number`);
  }
  return value;
}

function expectBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw configError(`"${key}" must be a boolean`);
  return value;
}

function expectStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw configError(`"${key}" must be an array of strings`);
  }
  return value as string[];
}

function expectAgentCli(value: unknown, context: string): AgentCli {
  if (typeof value !== 'string' || !(AGENT_CLIS as readonly string[]).includes(value)) {
    throw configError(`${context} must be one of: ${AGENT_CLIS.join(', ')}`);
  }
  return value as AgentCli;
}

function expectFallbackAgentCli(value: unknown, context: string): AgentCli {
  if (value === 'claude') return 'claude-code';
  return expectAgentCli(value, context);
}

function parseFallbackAgents(raw: Record<string, unknown>): FallbackAgentConfig[] | undefined {
  const value = raw.fallbackAgents;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw configError('"fallbackAgents" must be an array of agent objects');

  const seen = new Set<AgentCli>();
  return value.map((entry, index) => {
    const label = `fallbackAgents[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw configError(`"${label}" must be an object`);
    }
    const rawEntry = entry as Record<string, unknown>;
    for (const field of Object.keys(rawEntry)) {
      if (field !== 'agentCli' && field !== 'model' && field !== 'effort') {
        throw configError(`"${label}" has unknown field "${field}" (valid fields: agentCli, model, effort)`);
      }
    }
    const agentCli = expectFallbackAgentCli(rawEntry.agentCli, `"${label}.agentCli"`);
    if (seen.has(agentCli)) {
      throw configError(`"fallbackAgents" has duplicate agentCli "${agentCli}"`);
    }
    seen.add(agentCli);

    const fallback: FallbackAgentConfig = { agentCli };
    for (const field of ['model', 'effort'] as const) {
      const fieldValue = rawEntry[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
        throw configError(`"${label}.${field}" must be a non-empty string`);
      }
      fallback[field] = fieldValue;
    }
    return fallback;
  });
}

function parseTriageLabels(raw: Record<string, unknown>): Partial<Record<TriageRole, string>> | undefined {
  const value = raw.triageLabels;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('"triageLabels" must be an object mapping triage roles to label strings');
  }
  const labels: Partial<Record<TriageRole, string>> = {};
  for (const [key, label] of Object.entries(value)) {
    if (!(TRIAGE_ROLES as readonly string[]).includes(key)) {
      throw configError(`"triageLabels" has unknown role "${key}" (valid roles: ${TRIAGE_ROLES.join(', ')})`);
    }
    if (typeof label !== 'string' || !label.trim()) {
      throw configError(`"triageLabels.${key}" must be a non-empty string`);
    }
    labels[key as TriageRole] = label;
  }
  return labels;
}

function parseStages(raw: Record<string, unknown>): Partial<Record<StageName, StageAgentOverride>> | undefined {
  const value = raw.stages;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('"stages" must be an object keyed by stage name');
  }
  const stages: Partial<Record<StageName, StageAgentOverride>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(STAGE_NAMES as readonly string[]).includes(key)) {
      throw configError(`"stages" has unknown stage "${key}" (valid stages: ${STAGE_NAMES.join(', ')})`);
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw configError(`"stages.${key}" must be an object`);
    }
    const override: StageAgentOverride = {};
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (field === 'agentCli') {
        override.agentCli = expectAgentCli(fieldValue, `"stages.${key}.agentCli"`);
      } else if (field === 'model') {
        if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
          throw configError(`"stages.${key}.model" must be a non-empty string`);
        }
        override.model = fieldValue;
      } else if (field === 'effort') {
        if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
          throw configError(`"stages.${key}.effort" must be a non-empty string`);
        }
        override.effort = fieldValue;
      } else {
        throw configError(`"stages.${key}" has unknown field "${field}" (valid fields: agentCli, model, effort)`);
      }
    }
    stages[key as StageName] = override;
  }
  return stages;
}

function parseProjects(raw: Record<string, unknown>): Record<string, ProjectOverride> | undefined {
  const value = raw.projects;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('"projects" must be an object keyed by project folder name');
  }
  const projects: Record<string, ProjectOverride> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!name.trim()) throw configError('"projects" keys must be non-empty project names');
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw configError(`"projects.${name}" must be an object`);
    }
    const override: ProjectOverride = {};
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (field === 'usageLimits') {
        override.usageLimits = parsePolicyMap(fieldValue, `"projects.${name}.usageLimits"`);
        continue;
      }
      if (field === 'env') {
        override.env = parseEnvMap(fieldValue, `"projects.${name}.env"`);
        continue;
      }
      if (field === 'preflight') {
        override.preflight = parsePreflight(fieldValue, `"projects.${name}.preflight"`);
        continue;
      }
      if (field === 'allowDeclaredVerify') {
        if (typeof fieldValue !== 'boolean') {
          throw configError(`"projects.${name}.allowDeclaredVerify" must be a boolean`);
        }
        override.allowDeclaredVerify = fieldValue;
        continue;
      }
      if (field !== 'verifyCmd' && field !== 'prd' && field !== 'model' && field !== 'effort') {
        throw configError(
          `"projects.${name}" has unknown field "${field}" (valid fields: verifyCmd, prd, model, effort, env, preflight, allowDeclaredVerify, usageLimits)`,
        );
      }
      if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
        throw configError(`"projects.${name}.${field}" must be a non-empty string`);
      }
      override[field] = fieldValue;
    }
    projects[name] = override;
  }
  return projects;
}

function parseWebhooks(raw: Record<string, unknown>): WebhookConfig[] | undefined {
  const value = raw.webhooks;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw configError('"webhooks" must be an array of webhook objects');

  return value.map((entry, index) => {
    const label = `"webhooks[${index}]"`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw configError(`${label} must be an object`);
    }
    const hook = entry as Record<string, unknown>;
    const unknown = Object.keys(hook).filter((key) => !['url', 'events', 'format', 'headers'].includes(key));
    if (unknown.length > 0) {
      throw configError(`${label} has unknown field(s): ${unknown.join(', ')} (valid: url, events, format, headers)`);
    }
    if (typeof hook.url !== 'string' || !hook.url.trim()) {
      throw configError(`${label}.url must be a non-empty string`);
    }
    const webhook: WebhookConfig = { url: hook.url };
    if (hook.events !== undefined) {
      if (
        !Array.isArray(hook.events) ||
        hook.events.some((event) => !(WEBHOOK_EVENT_NAMES as readonly string[]).includes(event as string))
      ) {
        throw configError(`${label}.events must be an array of: ${WEBHOOK_EVENT_NAMES.join(', ')}`);
      }
      webhook.events = hook.events as WebhookEventName[];
    }
    if (hook.format !== undefined) {
      if (hook.format !== 'generic' && hook.format !== 'slack') {
        throw configError(`${label}.format must be "generic" or "slack"`);
      }
      webhook.format = hook.format;
    }
    if (hook.headers !== undefined) {
      if (typeof hook.headers !== 'object' || hook.headers === null || Array.isArray(hook.headers)) {
        throw configError(`${label}.headers must be an object of string values`);
      }
      for (const headerValue of Object.values(hook.headers)) {
        if (typeof headerValue !== 'string') throw configError(`${label}.headers values must be strings`);
      }
      webhook.headers = hook.headers as Record<string, string>;
    }
    return webhook;
  });
}

/** A `{ session?, weekly? }` policy map (used top-level, per-project, and for goal mode). */
function parsePolicyMap(value: unknown, label: string): Partial<UsageLimitsConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError(`${label} must be an object like { "session": "wait", "weekly": "stop" }`);
  }
  const limits: Partial<UsageLimitsConfig> = {};
  for (const [key, policy] of Object.entries(value)) {
    if (key !== 'session' && key !== 'weekly') {
      throw configError(`${label} has unknown scope "${key}" (valid scopes: session, weekly)`);
    }
    if (policy !== 'wait' && policy !== 'stop') {
      throw configError(`${label}.${key} must be "wait" or "stop"`);
    }
    limits[key] = policy as UsageLimitPolicy;
  }
  return limits;
}

function parseUsageLimits(raw: Record<string, unknown>): UsageLimitsConfig | undefined {
  const value = raw.usageLimits;
  if (value === undefined) return undefined;
  return { ...DEFAULT_CONFIG.usageLimits, ...parsePolicyMap(value, '"usageLimits"') };
}

/** A flat `{ NAME: "value" }` map, used top-level and per-project. */
function parseEnvMap(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError(`${label} must be an object of string values like { "NX_DAEMON": "false" }`);
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw configError(`${label}.${name} must be a string`);
    env[name] = entry;
  }
  return env;
}

/** A `{ cmd, message }` readiness probe, used top-level and per-project. */
function parsePreflight(value: unknown, label: string): PreflightConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError(`${label} must be an object like { "cmd": "pg_isready", "message": "start the database" }`);
  }
  const { cmd, message, ...rest } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw configError(`${label} has unknown field "${unknown[0]}" (valid fields: cmd, message)`);
  }
  if (typeof cmd !== 'string' || !cmd.trim()) throw configError(`${label}.cmd must be a non-empty string`);
  if (typeof message !== 'string' || !message.trim()) {
    throw configError(`${label}.message must be a non-empty string — it is what the operator is told to do about it`);
  }
  return { cmd, message };
}

function parseAgentRetries(raw: Record<string, unknown>): AgentRetriesConfig | undefined {
  const value = raw.agentRetries;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('"agentRetries" must be an object like { "attempts": 2, "initialDelayMs": 15000 }');
  }
  const retries: AgentRetriesConfig = { ...DEFAULT_CONFIG.agentRetries };
  for (const [key, field] of Object.entries(value)) {
    if (key !== 'attempts' && key !== 'initialDelayMs' && key !== 'maxDelayMs') {
      throw configError(
        `"agentRetries" has unknown field "${key}" (valid fields: attempts, initialDelayMs, maxDelayMs)`,
      );
    }
    // `attempts: 0` disables retrying, so this is the one field allowed to be zero.
    const floor = key === 'attempts' ? 0 : 1;
    if (typeof field !== 'number' || !Number.isInteger(field) || field < floor) {
      throw configError(
        `"agentRetries.${key}" must be a non-negative integer${floor === 1 ? ' greater than zero' : ''}`,
      );
    }
    retries[key] = field;
  }
  if (retries.maxDelayMs < retries.initialDelayMs) {
    throw configError('"agentRetries.maxDelayMs" must be at least "agentRetries.initialDelayMs"');
  }
  return retries;
}

function parseGoal(raw: Record<string, unknown>): GoalConfig | undefined {
  const value = raw.goal;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('"goal" must be an object like { "maxIssuesPerRound": 5, "roundLimit": 10 }');
  }
  const goal: GoalConfig = { ...DEFAULT_CONFIG.goal };
  for (const [key, field] of Object.entries(value)) {
    if (key === 'maxIssuesPerRound' || key === 'roundLimit' || key === 'supersedeLimit') {
      if (typeof field !== 'number' || !Number.isInteger(field) || field < 1) {
        throw configError(`"goal.${key}" must be a positive integer`);
      }
      goal[key] = field;
    } else if (key === 'usageLimits') {
      goal.usageLimits = parsePolicyMap(field, '"goal.usageLimits"');
    } else {
      throw configError(
        `"goal" has unknown field "${key}" (valid fields: maxIssuesPerRound, roundLimit, supersedeLimit, usageLimits)`,
      );
    }
  }
  return goal;
}

/** Parsed + validated contents of loop.config.json (no defaults applied). */
type FileConfig = Partial<
  Omit<LoopConfig, 'triageLabels' | 'stages'> & {
    triageLabels: Partial<Record<TriageRole, string>>;
    stages: Partial<Record<StageName, StageAgentOverride>>;
  }
>;

/** The raw JSON of one config file, or `{}` when it does not exist. */
function readRawConfig(filePath: string, fileName: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${fileName}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fileName}: must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Keys whose objects merge one level deep, so an overlay entry adds rather than replaces. */
const SHALLOW_MERGED_KEYS = new Set(['projects', 'stages', 'triageLabels', 'env', 'usageLimits', 'goal']);

function mergeRawConfigs(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    const mergeable =
      SHALLOW_MERGED_KEYS.has(key) &&
      typeof existing === 'object' && existing !== null && !Array.isArray(existing) &&
      typeof value === 'object' && value !== null && !Array.isArray(value);
    merged[key] = mergeable
      ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
      : value;
  }
  return merged;
}

function readConfigFile(root: string): FileConfig {
  const raw = mergeRawConfigs(
    readRawConfig(path.join(root, CONFIG_FILE_NAME), CONFIG_FILE_NAME),
    readRawConfig(path.join(root, LOCAL_CONFIG_FILE_NAME), LOCAL_CONFIG_FILE_NAME),
  );
  if (Object.keys(raw).length === 0) return {};

  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw configError(`unknown field(s): ${unknown.join(', ')}`);
  }

  const config: FileConfig = {};
  if (raw.agentCli !== undefined) config.agentCli = expectAgentCli(raw.agentCli, '"agentCli"');
  const model = expectString(raw, 'model');
  if (model !== undefined) config.model = model;
  const effort = expectString(raw, 'effort');
  if (effort !== undefined) config.effort = effort;
  const fallbackAgents = parseFallbackAgents(raw);
  if (fallbackAgents !== undefined) config.fallbackAgents = fallbackAgents;
  const verifyCmd = expectString(raw, 'verifyCmd');
  if (verifyCmd !== undefined) config.verifyCmd = verifyCmd;
  const issuesDir = expectString(raw, 'issuesDir');
  if (issuesDir !== undefined) config.issuesDir = issuesDir;
  const maxVerifyCycles = expectNumber(raw, 'maxVerifyCycles');
  if (maxVerifyCycles !== undefined) config.maxVerifyCycles = maxVerifyCycles;
  const maxReviewCycles = expectNumber(raw, 'maxReviewCycles');
  if (maxReviewCycles !== undefined) config.maxReviewCycles = maxReviewCycles;
  const agentTimeoutMs = expectNumber(raw, 'agentTimeoutMs');
  if (agentTimeoutMs !== undefined) config.agentTimeoutMs = agentTimeoutMs;
  const agentIdleTimeoutMs = expectNumber(raw, 'agentIdleTimeoutMs');
  if (agentIdleTimeoutMs !== undefined) config.agentIdleTimeoutMs = agentIdleTimeoutMs;
  const heartbeatIntervalMs = expectNumber(raw, 'heartbeatIntervalMs');
  if (heartbeatIntervalMs !== undefined) config.heartbeatIntervalMs = heartbeatIntervalMs;
  const showThinking = expectBoolean(raw, 'showThinking');
  if (showThinking !== undefined) config.showThinking = showThinking;
  const worktreeEnabled = expectBoolean(raw, 'worktreeEnabled');
  if (worktreeEnabled !== undefined) config.worktreeEnabled = worktreeEnabled;
  const keepAwake = expectBoolean(raw, 'keepAwake');
  if (keepAwake !== undefined) config.keepAwake = keepAwake;
  const reviewSkill = expectString(raw, 'reviewSkill');
  if (reviewSkill !== undefined) config.reviewSkill = reviewSkill;
  const tddSkill = expectString(raw, 'tddSkill');
  if (tddSkill !== undefined) config.tddSkill = tddSkill;
  const commitExcludePaths = expectStringArray(raw, 'commitExcludePaths');
  if (commitExcludePaths !== undefined) config.commitExcludePaths = commitExcludePaths;
  const installCmd = expectString(raw, 'installCmd');
  if (installCmd !== undefined) config.installCmd = installCmd;
  const dependencyFiles = expectStringArray(raw, 'dependencyFiles');
  if (dependencyFiles !== undefined) config.dependencyFiles = dependencyFiles;
  const prdsDir = expectString(raw, 'prdsDir');
  if (prdsDir !== undefined) config.prdsDir = prdsDir;
  const triageLabels = parseTriageLabels(raw);
  if (triageLabels !== undefined) config.triageLabels = triageLabels;
  const maxParallelRuns = expectNumber(raw, 'maxParallelRuns');
  if (maxParallelRuns !== undefined) config.maxParallelRuns = maxParallelRuns;
  const stages = parseStages(raw);
  if (stages !== undefined) config.stages = stages;
  const projects = parseProjects(raw);
  if (projects !== undefined) config.projects = projects;
  const webhooks = parseWebhooks(raw);
  if (webhooks !== undefined) config.webhooks = webhooks;
  if (raw.env !== undefined) config.env = parseEnvMap(raw.env, '"env"');
  if (raw.preflight !== undefined) config.preflight = parsePreflight(raw.preflight, '"preflight"');
  const allowDeclaredVerify = expectBoolean(raw, 'allowDeclaredVerify');
  if (allowDeclaredVerify !== undefined) config.allowDeclaredVerify = allowDeclaredVerify;
  const archiveDir = expectString(raw, 'archiveDir');
  if (archiveDir !== undefined) config.archiveDir = archiveDir;
  const usageLimits = parseUsageLimits(raw);
  if (usageLimits !== undefined) config.usageLimits = usageLimits;
  const agentRetries = parseAgentRetries(raw);
  if (agentRetries !== undefined) config.agentRetries = agentRetries;
  const goal = parseGoal(raw);
  if (goal !== undefined) config.goal = goal;

  return config;
}

function envNumber(env: ConfigEnv, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number (got "${raw}")`);
    }
    return value;
  }
  return undefined;
}

function envOverrides(env: ConfigEnv): Partial<LoopConfig> {
  const overrides: Partial<LoopConfig> = {};
  if (env.LOOP_MODEL) overrides.model = env.LOOP_MODEL;
  if (env.LOOP_VERIFY_CMD) overrides.verifyCmd = env.LOOP_VERIFY_CMD;
  const maxVerifyCycles = envNumber(env, 'LOOP_MAX_VERIFY_CYCLES', 'LOOP_MAX_VERIFY_FIX_CYCLES');
  if (maxVerifyCycles !== undefined) overrides.maxVerifyCycles = maxVerifyCycles;
  const maxReviewCycles = envNumber(env, 'LOOP_MAX_REVIEW_CYCLES', 'LOOP_MAX_REVIEW_ROUNDS');
  if (maxReviewCycles !== undefined) overrides.maxReviewCycles = maxReviewCycles;
  const agentTimeoutMs = envNumber(env, 'LOOP_AGENT_TIMEOUT_MS');
  if (agentTimeoutMs !== undefined) overrides.agentTimeoutMs = agentTimeoutMs;
  const agentIdleTimeoutMs = envNumber(env, 'LOOP_AGENT_IDLE_TIMEOUT_MS');
  if (agentIdleTimeoutMs !== undefined) overrides.agentIdleTimeoutMs = agentIdleTimeoutMs;
  const heartbeatIntervalMs = envNumber(env, 'LOOP_HEARTBEAT_INTERVAL_MS');
  if (heartbeatIntervalMs !== undefined) overrides.heartbeatIntervalMs = heartbeatIntervalMs;
  if (env.LOOP_SHOW_THINKING === '0') overrides.showThinking = false;
  if (env.LOOP_NO_WORKTREE === '1') overrides.worktreeEnabled = false;
  const maxParallelRuns = envNumber(env, 'LOOP_MAX_PARALLEL_RUNS');
  if (maxParallelRuns !== undefined) overrides.maxParallelRuns = maxParallelRuns;
  return overrides;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Load the fully-resolved config for a repo root. Precedence per field:
 * CLI flag > env var (where one exists) > loop.config.json > built-in default.
 */
export function loadConfig(
  root: string,
  options: { cli?: ConfigCliOverrides; env?: ConfigEnv } = {},
): LoopConfig {
  const fileConfig = readConfigFile(root);
  const env = envOverrides(options.env ?? process.env);
  const cli = definedEntries(options.cli ?? {});

  const config: LoopConfig = {
    ...DEFAULT_CONFIG,
    ...definedEntries(fileConfig),
    ...env,
    ...cli,
  };

  if (!Number.isInteger(config.maxParallelRuns) || config.maxParallelRuns < 1) {
    throw new Error(`maxParallelRuns must be a positive integer (got ${config.maxParallelRuns})`);
  }

  return config;
}
