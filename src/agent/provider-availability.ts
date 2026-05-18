import type { AgentCli } from '../config/types.js';
import { usageLimitRetryTargetMs } from '../usage/limit-wait.js';
import type { UsageLimitDetails } from './providers/usage-limit.js';

export type LimitedProvider = {
  agentCli: AgentCli;
  details: UsageLimitDetails;
  retryAtMs: number;
};

/**
 * Process-lifetime knowledge of provider quota availability. All stages in a
 * Loop invocation share the default instance; tests can inject an isolated
 * tracker with a deterministic clock.
 */
export class AgentAvailabilityTracker {
  readonly #limited = new Map<AgentCli, LimitedProvider>();

  constructor(private readonly now: () => number = Date.now) {}

  #limitFor(agentCli: AgentCli): LimitedProvider | null {
    const limited = this.#limited.get(agentCli);
    if (!limited) return null;
    if (this.now() < limited.retryAtMs) return limited;
    this.#limited.delete(agentCli);
    return null;
  }

  isAvailable(agentCli: AgentCli): boolean {
    return this.#limitFor(agentCli) === null;
  }

  markLimited(agentCli: AgentCli, details: UsageLimitDetails): LimitedProvider {
    const nowMs = this.now();
    const retryAtMs = usageLimitRetryTargetMs(details, nowMs);
    const existing = this.#limited.get(agentCli);
    if (existing && existing.retryAtMs >= retryAtMs) return existing;
    const limited = {
      agentCli,
      details: { ...details, retryAtMs },
      retryAtMs,
    };
    this.#limited.set(agentCli, limited);
    return limited;
  }

  soonestLimited(agentClis: readonly AgentCli[]): LimitedProvider | null {
    const limited = agentClis
      .map((agentCli) => this.#limitFor(agentCli))
      .filter((entry): entry is LimitedProvider => entry !== null);
    return limited.sort((left, right) => {
      const retryDifference = left.retryAtMs - right.retryAtMs;
      if (Math.abs(retryDifference) >= 1000) return retryDifference;
      if (left.details.scope === right.details.scope) return 0;
      return left.details.scope === 'session' ? -1 : 1;
    })[0] ?? null;
  }
}

export const processAgentAvailability = new AgentAvailabilityTracker();
