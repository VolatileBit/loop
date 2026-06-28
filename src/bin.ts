/**
 * `loop` entry point: subcommand dispatch. No subcommand → help; unknown →
 * help + exit 1.
 */

const SUBCOMMANDS = ['run'] as const;

function mainHelp(): string {
  return [
    'loop — autonomous issue-runner',
    '',
    'Usage: loop <command> [options]',
    '',
    'Commands:',
    '  run    work the issue backlog',
    '',
  ].join('\n');
}

function main(argv: string[]): number {
  const [first] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    console.log(mainHelp());
    return 0;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    console.error(`Unknown command: ${first}`);
    console.log(mainHelp());
    return 1;
  }
  console.log('loop run is not wired up yet');
  return 0;
}

process.exit(main(process.argv.slice(2)));
