# lastlook (bash): readline has no cancellable accept hook, so this uses the DEBUG trap with
# extdebug, where a non-zero return from the trap skips the command. The trap fires once per simple
# command rather than once per line, so the guards below keep it to top-level interactive commands.
shopt -s extdebug
__lastlook_enabled=1
lastlook-off() { __lastlook_enabled=0; printf 'lastlook off for this shell\n'; }
lastlook-on()  { __lastlook_enabled=1; printf 'lastlook on\n'; }

__lastlook_check() {
  local cmd=$1
  [[ $- == *i* ]] || return 0
  [[ $__lastlook_enabled == 1 ]] || return 0
  (( ${#FUNCNAME[@]} <= 2 )) || return 0
  (( BASH_SUBSHELL == 0 )) || return 0
  [[ -n ${cmd//[[:space:]]/} ]] || return 0
  case $cmd in lastlook*|__lastlook*|"$PROMPT_COMMAND") return 0 ;; esac
  # Prefer the line as typed, from history, over the single command the trap was given.
  # history prints "  123  command"; a command the user typed with a leading space keeps it, so
  # three spaces after the number is the escape hatch. With HISTCONTROL=ignorespace such a line is
  # not in history at all, and the mismatch below catches it instead.
  local line body
  line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  # Take everything after the history number, keeping the spacing that follows it intact.
  if [[ $line =~ ^[[:space:]]*[0-9]+(.*)$ ]]; then body=${BASH_REMATCH[1]}; else body=$line; fi
  case $body in "   "*) return 0 ;; esac
  line=${body#"${body%%[![:space:]]*}"}
  if [[ $line != *"${cmd%% *}"* ]]; then
    # The typed line is not in history. Either history is off or the line began with a space.
    case $HISTCONTROL in *ignorespace*|*ignoreboth*) return 0 ;; esac
    line=$cmd
  fi
  if LASTLOOK_CWD=$PWD command lastlook gate -- "$line" < /dev/tty > /dev/tty 2>&1; then
    return 0
  fi
  return 1
}
trap '__lastlook_check "$BASH_COMMAND" || return 1 2>/dev/null || false' DEBUG
