/**
 * Trusted merge-driver provisioning used before replay (inventory G089 dependency).
 * Owns applicability, interpreter isolation, and the checkout attribute binding.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunHostCommand } from './merge.ts'

/** The path the entry-aware driver is bound to, and the git config name it is bound under. */
const AS_BUILT_LOG_PATH = 'docs/AS_BUILT.md'
const AS_BUILT_DRIVER_NAME = 'as-built-log'

/**
 * The environment variables the merge driver is run WITHOUT.
 *
 * `GH_TOKEN` is the owner's credential, the one that publishes every PR; the `GIT_CONFIG_*` triple
 * is the credential helper that reads it back out (`github/credential.ts` `githubProcessEnv`), so
 * leaving those behind would hand a child `git` the same access under a different name.
 * `GITHUB_TOKEN` is not set by this codebase and is unset anyway because CI and developer shells
 * commonly do set it. A merge driver reads three files and writes one — none of this belongs in it.
 */
const CREDENTIAL_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']

/**
 * THIS INSTALLATION's copy of the merge driver — never the checkout's.
 *
 * Walks up from this module rather than joining a fixed `..`, because trident is a workspace
 * package: depending on whether the resolver hands back the real path or the
 * `node_modules/@neutronai/trident` symlink, the tree root is one hop up or three. Bounded, and a
 * `null` return simply means "do not install", which is the same outcome as not calling this.
 */
function ownAsBuiltMergeDriver(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let hop = 0; hop < 8; hop++) {
    const candidate = join(dir, 'scripts', 'git', 'as-built-merge-driver.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Single-quote a path for the shell string git stores as `merge.<name>.driver`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The command git will run for a merge, built so the TARGET CHECKOUT CANNOT INJECT CODE INTO IT.
 *
 * ⚠️ GIT RUNS A MERGE DRIVER WITH ITS CWD AT THE TOP OF THE WORKING TREE BEING MERGED, AND BUN
 * READS `bunfig.toml` FROM ITS CWD. So naming a trusted script is NOT on its own enough: a
 * `bunfig.toml` committed in the target repository with `preload = ["./anything.ts"]` runs that
 * file inside our driver process, before a line of our code, every time git merges this path.
 * That process is a child of the publisher's `run_host`, whose environment carries `GH_TOKEN`
 * (`open/composer.ts` `makeLazyCredentialedHostRunner` → `github/credential.ts` `githubProcessEnv`),
 * so the payload reads the owner's credential straight out of `process.env`. Reproduced on bun
 * 1.3.9: with the preload present the child printed `EXFIL GH_TOKEN=<the value>`; with
 * `--config=/dev/null` in front of the script it printed nothing and the script still ran. Round 1
 * closed the "which script runs" hole and left this one open, which is the same class of mistake
 * one layer down — the interpreter's own configuration is part of what an untrusted checkout
 * supplies.
 *
 * `--config=/dev/null` names an empty TOML file, so the checkout's `bunfig.toml` supplies no
 * `preload`, no `loader` and no registry override. The driver needs none of that: it reads three
 * files and writes one. (Scope, stated rather than overclaimed: what was MEASURED is the cwd
 * `bunfig.toml`, which is the one an untrusted checkout controls. Whether the flag also displaces a
 * `$HOME/.bunfig.toml` was not measured and nothing here depends on it — `$HOME` on the publisher
 * host is as trusted as the interpreter itself.)
 *
 * …AND `--env-file=/dev/null`, BECAUSE `--config` DOES NOT COVER `.env`. bun auto-loads a `.env`
 * from its cwd, which under a merge driver is the checked-out repository, and it does so
 * INDEPENDENTLY of `bunfig.toml` — measured on bun 1.3.9: with `--config=/dev/null` alone, a `.env`
 * sitting in the cwd still reached `process.env` inside the driver; with `--env-file=/dev/null` in
 * front of it, it did not. No escalation from that injection was demonstrated (the inherited `PATH`
 * wins over one supplied this way), so this is closing an input rather than a proven exploit — but
 * the property this code is FOR is that nothing the checkout ships decides anything inside the
 * driver process, and an environment it writes is such a thing.
 *
 * AND THE CREDENTIAL IS TAKEN OUT OF SCOPE ENTIRELY. `env -u GH_TOKEN …` prefixes the command, so
 * the owner's token — and the `GIT_CONFIG_*` triple whose credential helper reads it
 * (`github/credential.ts` `githubProcessEnv`) — is simply not in the environment of a process whose
 * whole job is to read three files and write one. The isolation above is about what the checkout
 * can INJECT; this is about what is there to steal if some future injection succeeds anyway. Two
 * independent controls, because "nothing can get in" is a claim that has already been wrong twice
 * on this code path.
 *
 * `null` when the interpreter is not bun. The driver is a `.ts` module, so nothing else can run it
 * anyway, and rather than infer that some other interpreter would honour a `--config` flag with the
 * same meaning, this refuses to install — which leaves the checkout merging the log exactly as it
 * does today.
 *
 * KNOWN LIMIT, AND IT FAILS IN THE SAFE DIRECTION. Both `/dev/null` flags and `/usr/bin/env` are
 * POSIX paths; a host without them would fail the merge (exit non-zero → git reports a conflict)
 * rather than merge wrongly. Trident runs on macOS and Linux, where all three exist.
 */
function asBuiltDriverCommand(driver: string): string | null {
  if (basename(process.execPath).replace(/\.exe$/i, '') !== 'bun') return null
  // An absolute `env`, not a bare one, so the lookup does not depend on a PATH at all. POSIX puts
  // it at `/usr/bin/env` and both hosts trident runs on have it there; the bare name is a fallback
  // rather than a guess, and a host with neither fails the merge loudly instead of quietly.
  const env = existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env'
  const scrubbed = CREDENTIAL_ENV.map((name) => `-u ${name}`).join(' ')
  return `${env} ${scrubbed} ${shellQuote(process.execPath)} --config=/dev/null --env-file=/dev/null ${shellQuote(driver)} %O %A %B %L %P`
}

/**
 * Bind the entry-aware `docs/AS_BUILT.md` merge driver in a build checkout, where it applies.
 *
 * ⚠️ FILE PRESENCE IN THE TARGET CHECKOUT IS NOT AUTHORIZATION, AND NOTHING FROM THE TARGET
 * CHECKOUT IS EXECUTED HERE. The first cut of this took the presence of
 * `scripts/install-merge-drivers.sh` as its condition and then ran it: `run_host(['bash',
 * installer])`. The production `run_host` is `makeLazyCredentialedHostRunner` (`open/composer.ts`),
 * whose environment carries `GH_TOKEN` (`github/credential.ts` `githubProcessEnv`) — the owner's
 * credential, the one that publishes every PR. So any repository the publisher checked out that
 * happened to contain a file at that path got that file EXECUTED on the publisher host with the
 * token readable from its environment. "We only ever check out our own repositories" is an
 * assumption about how trident is pointed, not a control over it, and it is not the assumption a
 * credential should rest on.
 *
 * WHAT REPLACES IT. The two halves the installer wrote — the `merge.<name>.driver` config and the
 * `$GIT_COMMON_DIR/info/attributes` binding — are written directly from here, and the command they
 * name is THIS installation's `scripts/git/as-built-merge-driver.ts` under the interpreter already
 * running this process. Nothing under `repoPath` is executed, at install time or at merge time, so
 * a same-named script in a target repo is inert: it is never read, never run, and never named in
 * the config. That also closes the second half of the same hole — the old installer configured the
 * TARGET's driver script, which git would then have run under the same credential on every merge
 * touching this path.
 *
 * …AND NEITHER IS THE INTERPRETER'S CONFIGURATION, WHICH IS THE THIRD WAY IN. Naming a trusted
 * script is not sufficient while the checkout still supplies the `bunfig.toml` and the `.env` that
 * script starts under — see `asBuiltDriverCommand`, where the `--config=/dev/null` and
 * `--env-file=/dev/null` that close those live, with the reproductions. The property to hold onto
 * is the one this whole docblock is about: NOTHING the target checkout contains — not a script, not
 * a config, not an environment file, not a `PATH` — decides what RUNS on the publisher host. And
 * because that property has been stated confidently and been incomplete twice already, the
 * credential itself is now taken out of the driver's environment as a second, independent control.
 *
 * "WHAT RUNS" IS THE EXACT CLAIM, AND IT IS NOT "NOTHING FROM THE CHECKOUT REACHES THE DRIVER".
 * The word was load-bearing and the sentence above used to lack it, which made it false: git
 * substitutes `%L` from the merged path's `conflict-marker-size` attribute, and a TRACKED
 * `.gitattributes` in the checkout sets that. Verified by configuring a driver that does nothing but
 * print `%L` — a committed `conflict-marker-size=2000000` arrived intact. It selects no code and
 * executes nothing, but it did size a buffer: the conflict `as-built-merge-driver.ts` constructs
 * grew from 302 bytes to 6,000,281 on that value, linearly. It is clamped there now
 * (`MAX_MARKER_SIZE`), on BOTH conflict paths — the first clamp covered only the constructed
 * conflict and left the delegated one forwarding `%L` to `git merge-file`, which a cross-model
 * reviewer caught: the exemption rested on the delegated path being byte-for-byte an unconfigured
 * repo, and without this driver the path is `merge=union`, which never conflicts and writes no
 * markers at all. So the one checkout-supplied input the driver takes is bounded wherever it lands.
 * The general lesson is worth more than the fix: an absolute claim about a boundary should be read
 * against every argument that crosses it, and `%O %A %B %L %P` had five — and an EXEMPTION from a
 * bound needs its justification checked as hard as the bound itself, because this one was a
 * confident sentence about behaviour a file in this repository already contradicted.
 *
 * ONLY WHERE IT APPLIES. Two conditions, both read as DATA and neither executed: the checkout has
 * the log, and it carries this log's merge contract (`scripts/git/as-built-log-merge.ts`), which is
 * what distinguishes a repo using this layout from one that merely has a file by that name. A repo
 * failing either is left completely untouched, so nothing here imposes one repo's changelog layout
 * on another (Argus, round 1). Presence still decides APPLICABILITY — but applicability now
 * authorises only "merge this one path with our own reviewed code, or conflict", which is a
 * decision an untrusted repo is welcome to make.
 *
 * ORDER IS LOAD-BEARING, AND IT IS CHOSEN SO THE FATAL HALF-STATE CANNOT BE REACHED AT ALL.
 * `merge.<name>.driver` is written FIRST, `merge.<name>.name` — which is only a human-readable
 * description — second, and the attribute last, skipped entirely unless the driver landed. Measured
 * on git 2.50.1: a lone `.driver` with NO `.name` merges perfectly (the driver ran, exit 0), while a
 * lone `.name` with no `.driver` is `fatal: custom merge driver as-built-log lacks command line`,
 * exit 128. Round 1 wrote `.name` first and rolled it back by hand when `.driver` failed, which
 * meant the fatal state existed for a moment and its cleanup was a second write that the very
 * condition causing the failure (a held `config.lock`) would also have blocked. Writing the
 * load-bearing half first deletes the state instead of cleaning up after it, so there is no
 * rollback to fail. Attribute-without-driver stays fatal, and driver-without-attribute stays inert,
 * which is why the attribute is still last. Same rule as the standalone installer, for the same
 * reason.
 *
 * BEST EFFORT, NEVER FATAL. A failure to install leaves the checkout merging exactly as it does
 * today, which is the same outcome as not calling this at all. Publishing must not be blocked by an
 * optimisation to publishing.
 *
 * WHAT "EXACTLY AS IT DOES TODAY" ACTUALLY IS, IN THIS REPOSITORY, SAID PRECISELY. It is NOT a
 * conflict: `.gitattributes` carries `docs/AS_BUILT.md merge=union`, which never conflicts and
 * interleaves the two sides line by line — the failure this driver exists to replace. The attribute
 * written here lives in `$GIT_COMMON_DIR/info/attributes`, which git resolves BEFORE the tracked
 * `.gitattributes` (measured: with both present, `git check-attr merge -- <path>` reports the
 * info/attributes value), so a successful install genuinely displaces `union`. An UNSUCCESSFUL one
 * leaves `union` in charge — worse than a conflict, and the honest floor, which is why it is written
 * here rather than a nicer sentence about conflict markers. The tracked line stays because deleting
 * it would hand every fresh clone, outside contributor and CI job the conflict storm it was added to
 * stop; displacing it where the driver IS installed is the whole mechanism.
 *
 * Returns whether the driver is installed and usable afterwards.
 */
export async function ensureAsBuiltMergeDriver(
  run_host: RunHostCommand,
  repoPath: string,
): Promise<boolean> {
  if (!existsSync(join(repoPath, ...AS_BUILT_LOG_PATH.split('/')))) return false
  if (!existsSync(join(repoPath, 'scripts', 'git', 'as-built-log-merge.ts'))) return false

  const driver = ownAsBuiltMergeDriver()
  if (driver === null) return false

  // `process.execPath` is the interpreter already running trident, so the driver is reached without
  // consulting the target checkout's PATH for a `bun` it might supply itself — and `--config` stops
  // it reading the checkout's `bunfig.toml`. `null` means "not bun": do not install.
  const command = asBuiltDriverCommand(driver)
  if (command === null) return false

  try {
    // THE LOAD-BEARING HALF FIRST. A lone `.driver` is a working driver; a lone `.name` is fatal.
    const configured = await run_host(
      ['git', '-C', repoPath, 'config', `merge.${AS_BUILT_DRIVER_NAME}.driver`, command],
      repoPath,
    )
    if (!configured.ok) return false
    // Cosmetic, and deliberately unchecked: it is what `git config --get-regexp merge.` prints to a
    // human, and its absence changes nothing about how the merge runs.
    await run_host(
      ['git', '-C', repoPath, 'config', `merge.${AS_BUILT_DRIVER_NAME}.name`, 'entry-aware merge for the AS_BUILT log'],
      repoPath,
    )

    // The COMMON git dir, not the per-worktree one: a linked worktree reads attributes from the
    // common one, which is what the publisher's throwaway rebase worktree depends on.
    //
    // AND `--path-format=absolute` NEEDS A FALLBACK, because it arrived in git 2.31 and a `git`
    // that predates it exits non-zero on the flag rather than ignoring it. Returning false there
    // would be the silent-regression shape this file keeps finding: `merge.<driver>.driver` is
    // ALREADY written by the time this runs, so a bare `return false` leaves the config half-placed
    // and the attribute unwritten, and the replay then proceeds under the tracked `merge=union`
    // while trident reports the driver as unavailable. The shell installer has always had this
    // fallback (`scripts/install-merge-drivers.sh`); this call site did not.
    let commonDir = ''
    const common = await run_host(
      ['git', '-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      repoPath,
    )
    if (common.ok) commonDir = common.stdout.trim()
    else {
      // AND THE FALLBACK'S ANSWER IS CHECKED, BECAUSE A RELATIVE ONE IS NOT RELATIVE TO WHAT YOU
      // WOULD GUESS. In a LINKED worktree the common dir is recorded in
      // `<main>/.git/worktrees/<name>/commondir` as `../..` — relative to THAT file's directory, not
      // to the working tree. Measured here: modern git normalises the `-C` form to an absolute path
      // (`/…/neutron-open/.git`) so this branch never runs, but the whole point of this branch is a
      // git old enough not to have `--path-format`, and resolving `../..` against `repoPath` would
      // land two levels above the WORKTREE — a real directory, outside the repository, where an
      // attributes file would be silently inert. So the resolved directory has to prove it is a git
      // dir before anything is written into it; if it cannot, this returns false and the caller is
      // exactly where it was. Writing to the wrong place is worse than not writing.
      const plain = await run_host(['git', '-C', repoPath, 'rev-parse', '--git-common-dir'], repoPath)
      if (!plain.ok) return false
      const raw = plain.stdout.trim()
      if (raw === '') return false
      const resolved = isAbsolute(raw) ? raw : join(repoPath, raw)
      if (!existsSync(join(resolved, 'HEAD'))) return false
      commonDir = resolved
    }
    if (commonDir === '') return false

    const attributes = join(commonDir, 'info', 'attributes')
    const line = `${AS_BUILT_LOG_PATH} merge=${AS_BUILT_DRIVER_NAME}`
    const existing = existsSync(attributes) ? readFileSync(attributes, 'utf8') : ''
    if (existing.split('\n').includes(line)) return true

    // Per-process scratch file + rename, because two lanes can reach this on one checkout at the
    // same moment and a shared scratch path is its own concurrency bug (a racing reader would see
    // a half-written attributes file). Same construction as the standalone installer.
    mkdirSync(dirname(attributes), { recursive: true })
    const scratch = `${attributes}.tmp.${process.pid}`
    writeFileSync(scratch, existing === '' || existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`)
    renameSync(scratch, attributes)
    return true
  } catch {
    return false
  }
}

