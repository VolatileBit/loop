/**
 * Shell completion script generation for `loop completion <bash|zsh>`.
 *
 * The generated script shells out to the hidden `loop __complete -- <words...>`
 * command with the words after `loop` up to the cursor (including the
 * partial word being completed) and feeds the newline-separated candidates
 * back into compgen/compadd. Install with `eval "$(loop completion zsh)"`.
 */

import type { CompletionShell } from './args.js';

const BASH_SCRIPT = `# loop bash completion — install with: eval "$(loop completion bash)"
_loop_complete() {
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local candidates
  candidates="$(loop __complete -- "\${words[@]}" 2>/dev/null)"
  local IFS=$'\\n'
  COMPREPLY=($(compgen -W "\${candidates}" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -o default -F _loop_complete loop
`;

const ZSH_SCRIPT = `# loop zsh completion — install with: eval "$(loop completion zsh)"
_loop() {
  local -a candidates
  local -a args
  args=("\${(@)words[2,CURRENT]}")
  candidates=("\${(@f)$(loop __complete -- "\${args[@]}" 2>/dev/null)}")
  candidates=("\${(@)candidates:#}")
  (( \${#candidates} )) && compadd -- "\${candidates[@]}"
}
compdef _loop loop
`;

export function generateCompletionScript(shell: CompletionShell): string {
  return shell === 'bash' ? BASH_SCRIPT : ZSH_SCRIPT;
}
