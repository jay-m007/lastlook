# lastlook

A last look at a shell command before it runs.

You press enter on `rm -rf build/ ../src`. lastlook works out that this would delete 214 files, that
41 of them are outside the repository, that three have changes git has never seen, and that nothing
would bring those three back. Then it asks whether you meant it.

```
$ rm -rf build/ ../src

  check  41 files are outside this repository.
         · the repository is ~/work/api
         · outside: /Users/jay/work/shared
         · 214 files in 12 folders, 1.8 MB
         back: git cannot help with anything outside the repository
  check  3 files have changes that are not committed.
         · changed, not committed: src/auth.ts
         · git has no copy of these changes, only of the last committed version
         back: nothing to undo this
         try:  git stash push -- src/auth.ts keeps them first

  [enter] cancel   [y] run   [l] list the files
```

Nothing is sent anywhere. The explanation comes from a model running on your own machine, and the
decision to ask never comes from the model at all.

## Install

Needs Node 22.18 or newer, which runs TypeScript directly.

```
git clone https://github.com/jay-m007/lastlook
cd lastlook && npm install && npm link
lastlook install            # prints the one line to add to your shell
```

Then add that line to `~/.bashrc` or `~/.zshrc`:

```
eval "$(lastlook hook bash)"     # or zsh
```

The model is optional. Without Ollama, lastlook still works: you get the rules' own wording instead
of a one-line summary.

```
ollama pull llama3.2:1b     # about 1.3 GB; a bigger model is too slow to sit at a prompt
```

## What it actually checks

A rule only reports what it can establish. It reads the filesystem, asks git, and reads your
kubeconfig; it never guesses.

| Area | What it works out |
|---|---|
| `rm`, `rmdir` | real file counts behind a glob, paths outside the repo, files with uncommitted changes, files git has never seen, symlinks, and the unset-variable case where `rm -rf "$BUILD/"` becomes `rm -rf /` |
| `git` | force push with and without a lease, whether the branch is the default one, whether there is an upstream to compare against at all, `reset --hard` against a dirty tree, what `clean -fdx` would take, amending a commit that is already pushed, `filter-branch`, `gc --prune=now`, stash drops |
| databases | `DELETE` or `UPDATE` with no `WHERE`, `DROP`, `TRUNCATE`, `FLUSHALL`, and whether the host in your environment looks like production (the password is never shown or logged) |
| Kubernetes | `delete`, `delete --all`, `scale --replicas=0`, `drain`, `helm uninstall`, named with the cluster and namespace that are actually current |
| Terraform | `destroy`, and `apply -auto-approve` on a production workspace |
| clouds | `aws s3 rm --recursive`, `aws s3 rb`, `gsutil rm -r`, `rclone purge` and `rclone sync` |
| Docker | `system prune --volumes`, `volume rm`, `compose down -v` |
| disks | `dd of=/dev/…`, `mkfs`, `shred`, and a redirect that points at a device |
| permissions | `chmod 777`, and `chmod -R` or `chown -R` on a system folder |
| the line itself | `curl … \| sh`, the same with `sudo`, fork bombs, `history -c` |
| anything else | `find -delete`, `sed -i` without a backup, `> file` truncating a file that has unsaved work, `npm publish`, `rsync --delete`, `ssh host "rm -rf …"`, `kill 1` |

Run `lastlook rules` to list them, and `lastlook check -v -- '<command>'` to see rule ids and timings.

Three levels: a **note** prints and gets out of the way, a **check** asks, and a **stop** makes you
type the word `run`. A command with nothing to flag prints nothing at all — that is the common case,
and it is the reason this is bearable at every prompt.

## What the model does, and what it is not allowed to do

The model gets a short fact sheet the rules produced. It never sees file contents, your environment,
or anything it was not handed.

It has two jobs:

1. **One sentence** summarising facts the rules already established.
2. **Judging a program no rule covers.** When you run `flyctl apps destroy`, lastlook has no rule for
   `flyctl`. The model is asked whether the command looks destructive and which argument worries it.

Both are checked before you see them:

- The argument the model names **must appear in your command**, character for character. If it does
  not, the answer is thrown away, because the model made it up.
- A model answer can only ever add a **note**. It cannot raise a severity, clear a finding, or decide
  anything. Nothing it says can block a command, and nothing it says can let one through.
- It is given **300 ms**. Past that the request is abandoned and you get the rules' own wording. A
  shell hook that makes you wait is worse than no shell hook.
- Anything the model adds is labelled as its opinion, not as a checked fact.

`npm run eval` measures exactly this against your own machine: latency percentiles, how often a
figure appears in a summary that was not in the facts, and how it does on 20 commands from tools
lastlook has no rules for.

## Honest limits

- **It is a seatbelt, not a sandbox.** Everything here is advisory. A command you confirm runs with
  your full permissions, and anything that goes wrong afterwards goes wrong normally.
- **It only sees what you type at the prompt.** A destructive command inside a Makefile, a npm
  script, a CI job, a `.sh` file you run, or a program that deletes files itself is invisible to it.
  It does look inside `bash -c "…"`, `eval` and `xargs` on the line you typed.
- **bash is checked less precisely than zsh.** zsh replaces the accept-line widget, so it sees the
  whole line exactly as typed. bash has no cancellable hook for enter, so it uses the DEBUG trap with
  `extdebug`, where a non-zero return skips the command. That trap fires once per simple command
  rather than once per line, and it reads the line back from `history`, so a command whose text
  history mangles may be checked in a slightly different form than you typed. The leading-space
  escape hatch in bash works by looking at the spacing in `history` output, or by noticing that
  `HISTCONTROL` kept the line out of history.
- **fish is not supported.**
- **Paths are only as knowable as the shell makes them.** `rm -rf $(cat list)` cannot be checked
  before it runs, and lastlook says so rather than passing it as safe.
- **Production is guessed from names.** A cluster, workspace or database host counts as production
  when its name contains prod, production or live, or when `NODE_ENV=production`. A production
  database called `maindb` will not be recognised.
- **It cannot see the other end of an ssh connection.** It flags a destructive remote command and
  says plainly that it does not know what is on that machine.
- **Symlinks are never followed** when counting, so a symlink to a large folder is reported as one
  symlink, which is what `rm` would actually remove.
- **It is not a security tool.** Anyone who wants to get round it can: put a space in front of the
  line, run `lastlook-off`, or run their command from a script.
- **The counts are a snapshot.** They are taken when you press enter. If something else is writing
  to those folders at the same time, the real numbers will differ.
- **A crash lets the command through.** If lastlook itself fails, it says so and does not block your
  shell. A tool like this must never be the reason you cannot work.

## Development

```
npm test          # 89 tests, no network and no model needed
npm run typecheck
npm run eval      # needs Ollama; measures the model on your machine
```

The test suite builds real git repositories in temp folders, because every rule here reads real
files, and it drives a real interactive bash inside a pseudo-terminal to prove the hook actually
stops a command rather than just printing about it.

MIT licensed.
