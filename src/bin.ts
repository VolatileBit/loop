/**
 * `loop` entry point: subcommand dispatch. No subcommand → help; unknown →
 * help + exit 1. The hidden `__complete` command backs the generated shell
 * completion scripts and must never fail (it prints whatever candidates it
 * can resolve and exits 0).
 */

import { parseCliArgs, type ParsedCli } from './cli/args.js';
import { resolveCompletions } from './cli/complete.js';
import { generateCompletionScript } from './cli/completion.js';
import {
  completionHelp,
  fixNitsHelp,
  goalHelp,
  goalsHelp,
  initHelp,
  installHelp,
  listRunsHelp,
  mainHelp,
  loopVersion,
  polishHelp,
  archiveHelp,
  reviewHelp,
  runHelp,
} from './cli/help.js';
import { fixNitsCommand } from './commands/fix-nits.js';
import { goalCommand, goalsCommand } from './commands/goal.js';
import { archiveCommand } from './commands/archive.js';
import { polishCommand } from './commands/polish.js';
import { installCommand } from './commands/install.js';
import { initCommand } from './commands/init.js';
import { listRunsCommand } from './commands/list-runs.js';
import { reviewCommand } from './commands/review.js';
import { runCommand } from './commands/run.js';
import { failStop } from './interrupt/shutdown.js';
import { startInvocationLog } from './logs/invocation-log.js';
import { resolveRoot } from './shared/paths.js';

/**
 * Mutating commands tee their console output to `.loop/logs/` so run
 * information survives a closed terminal. Dry-runs stay read-only; help,
 * completion, and list commands have nothing durable to say.
 */
function maybeStartInvocationLog(parsed: ParsedCli): void {
  if (
    parsed.command !== 'run' &&
    parsed.command !== 'review' &&
    parsed.command !== 'fix-nits' &&
    parsed.command !== 'polish' &&
    parsed.command !== 'archive' &&
    parsed.command !== 'goal'
  ) {
    return;
  }
  if (parsed.flags.help || parsed.flags.dryRun) return;
  try {
    const { logPath } = startInvocationLog(resolveRoot(), parsed.command);
    console.log(`[loop] invocation log: ${logPath}`);
  } catch {
    // Not a repo yet / unwritable .loop — the command itself will say so.
  }
}

async function dispatch(parsed: ParsedCli): Promise<never> {
  if (parsed.command === 'help') {
    console.log(mainHelp());
    process.exit(0);
  }

  if (parsed.command === 'version') {
    console.log(loopVersion());
    process.exit(0);
  }

  if (parsed.command === 'unknown') {
    console.error(`loop: unknown command "${parsed.name}"\n`);
    console.error(mainHelp());
    process.exit(1);
  }

  if (parsed.command === '__complete') {
    for (const candidate of resolveCompletions(parsed.words)) {
      console.log(candidate);
    }
    process.exit(0);
  }

  if (parsed.command === 'completion') {
    if (parsed.help) {
      console.log(completionHelp());
      process.exit(0);
    }
    if (parsed.shell === null) {
      console.error(completionHelp());
      process.exit(1);
    }
    process.stdout.write(generateCompletionScript(parsed.shell));
    process.exit(0);
  }

  maybeStartInvocationLog(parsed);

  if (parsed.command === 'list-runs') {
    if (parsed.help) {
      console.log(listRunsHelp());
      process.exit(0);
    }
    listRunsCommand();
  }

  if (parsed.command === 'run') {
    if (parsed.flags.help) {
      console.log(runHelp());
      process.exit(0);
    }
    return runCommand(parsed.flags);
  }

  if (parsed.command === 'fix-nits') {
    if (parsed.flags.help) {
      console.log(fixNitsHelp());
      process.exit(0);
    }
    return fixNitsCommand(parsed.flags);
  }

  if (parsed.command === 'polish') {
    if (parsed.flags.help) {
      console.log(polishHelp());
      process.exit(0);
    }
    return polishCommand(parsed.flags);
  }

  if (parsed.command === 'archive') {
    if (parsed.flags.help) {
      console.log(archiveHelp());
      process.exit(0);
    }
    return archiveCommand(parsed.flags);
  }

  if (parsed.command === 'goal') {
    if (parsed.flags.help) {
      console.log(goalHelp());
      process.exit(0);
    }
    return goalCommand(parsed.flags);
  }

  if (parsed.command === 'goals') {
    if (parsed.help) {
      console.log(goalsHelp());
      process.exit(0);
    }
    goalsCommand(resolveRoot());
  }

  if (parsed.command === 'install') {
    if (parsed.flags.help) {
      console.log(installHelp());
      process.exit(0);
    }
    return installCommand(parsed.flags);
  }

  if (parsed.command === 'init') {
    if (parsed.flags.help) {
      console.log(initHelp());
      process.exit(0);
    }
    return initCommand(parsed.flags);
  }

  if (parsed.flags.help) {
    console.log(reviewHelp());
    process.exit(0);
  }
  return reviewCommand(parsed.flags);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Completion must never surface parse errors into the user's shell.
  if (argv[0] === '__complete') {
    try {
      await dispatch(parseCliArgs(argv));
    } catch {
      process.exit(0);
    }
    return;
  }

  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    failStop('invalid arguments', {
      details: [String(error instanceof Error ? error.message : error), 'Run `loop --help` for usage.'],
    });
  }

  await dispatch(parsed);
}

void main();
