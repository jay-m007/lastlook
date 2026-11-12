# lastlook (zsh): replaces the accept-line widget so that Enter can be refused.
# The widget sees the whole line exactly as typed, and if the answer is no, accept-line is simply
# never called, which leaves the line in the buffer to edit.
__lastlook_enabled=1
lastlook-off() { __lastlook_enabled=0; print -r -- "lastlook off for this shell"; }
lastlook-on()  { __lastlook_enabled=1; print -r -- "lastlook on"; }

__lastlook_accept_line() {
  emulate -L zsh
  setopt local_options no_err_return
  local buf=$BUFFER
  # Nothing typed, lastlook off, a line starting with a space, or lastlook itself: accept as normal.
  if [[ -z ${buf//[[:space:]]/} || $__lastlook_enabled != 1 || $buf == ' '* || $buf == 'lastlook'* ]]; then
    zle .accept-line
    return
  fi
  zle -I                                  # let output appear above the prompt
  if LASTLOOK_CWD=$PWD command lastlook gate -- "$buf" < /dev/tty > /dev/tty 2>&1; then
    zle .accept-line
  else
    zle reset-prompt
  fi
}
zle -N __lastlook_accept_line
bindkey '^M' __lastlook_accept_line
bindkey '^J' __lastlook_accept_line
