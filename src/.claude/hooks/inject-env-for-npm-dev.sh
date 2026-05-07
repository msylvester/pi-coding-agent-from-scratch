#!/bin/bash
# PreToolUse hook for Bash: when the command runs `npm run dev`,
# rewrite it to source the nearest .env (cwd or any parent) first.
set -eu

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Match `npm run dev` as a discrete word (allow leading prefix like `timeout 10`,
# trailing args/redirs/separators). Excludes `dev:web`, `dev-foo`, etc.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|(])npm[[:space:]]+run[[:space:]]+dev([[:space:];&|)>]|$)'; then
  wrapper='__d="$PWD"; while [ "$__d" != "/" ]; do if [ -f "$__d/.env" ]; then set -a; . "$__d/.env"; set +a; break; fi; __d="$(dirname "$__d")"; done; '
  new_cmd="${wrapper}${cmd}"
  jq -cn --arg c "$new_cmd" '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: {command: $c}}}'
fi
# else: no output → hook is a no-op
