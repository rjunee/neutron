## 2026-09-14 — The browser walkthrough was unrun, not failing (#602)

### The correction

#790 recorded that `tests/e2e-browser/onboarding_walkthrough.py` "is red in the
build lane, so wiring it would knowingly add a failing job". Its own evidence
section already named the true cause — `ModuleNotFoundError` on the Playwright
import — but the conclusion was stated as a property of the walkthrough. It is a
property of the host, and the two have different owners.

Measured here, on current main:

```
$ python3 tests/e2e-browser/onboarding_walkthrough.py
Traceback (most recent call last):
  File "tests/e2e-browser/onboarding_walkthrough.py", line 686, in <module>
    sys.exit(run())
  File "tests/e2e-browser/onboarding_walkthrough.py", line 244, in run
    from playwright.sync_api import sync_playwright
ModuleNotFoundError: No module named 'playwright'
EXIT=1
```

`python3 -c "import playwright"` fails on this box and `pip list` carries no
Playwright. The import is the FIRST statement of `run()`, above `server_up()`, so
the walkthrough exits before it checks anything. **Not one assertion in it has
been executed.** `docs/research/fullpipe-e2e-2026-06-28.md:21` records a full PASS
in a provisioned environment, which is the only evidence anywhere about whether
its assertions hold.

So the issue is "this has no lane that can run it", not "this is broken". Nothing
here wires it, for the same reason #790 gave.

### The defect that made the misreading possible

The file documents its own contract in its first docstring: *"EXIT CODES — 0 pass,
1 a real failure, **2 could-not-run**. The third one is the point."* It exists
because the script used to print `E2E SKIP` and exit 0, making "everything passed"
and "nothing was checked" one observable.

It then broke that contract on its first executable line. A bare import above
every guard means a missing prerequisite exits **1** — the code reserved for a
real failure — with a traceback, so "could not find out" and "found it wrong" were
indistinguishable to anything reading the exit code. That is what the lane read,
and it is the same false-vs-unknown collapse the docstring was written against.

Fixed: the import is caught and reports the could-not-run outcome the file already
had. It is exit 2 whether or not `E2E_ALLOW_SKIP` is set — an absent binding is
not something a caller can opt out of, and returning 0 there is the false green
this file exists to refuse.

### The no-caller claim, re-verified

`git grep -nE 'onboarding_walkthrough\.py|run-pty-e2e\.sh' -- ':!docs/**'
':!tests/e2e-browser/onboarding_walkthrough.py'` — the positive control
(`run-pty-e2e.sh`) matches real callers at `scripts/run-pty-e2e.sh:24-25` and
`tests/integration/pty-e2e-registered.test.ts:32`; the walkthrough half matches
only documentation. An unrestricted `git grep onboarding_walkthrough` returns nine
hits, every one of them a `docs/` line. The absence claim holds, and its control
works.

### Mutation

| guard | mutation | result |
|---|---|---|
| could-not-run exit code | restore the bare `from playwright.sync_api import …` (`onboarding_walkthrough.py:255`) | RED — both cases: exit 1 with a `Traceback`, and the source-shape check |

`tests/integration/e2e-browser-walkthrough-exit-codes.test.ts` is discovered and
run by the ordinary shards. It points `NEUTRON_BASE_URL` at a closed port, so it
reaches a could-not-run outcome in under a second on ANY host, with or without
Playwright, and never drives a browser. A host with no `python3` (exit 127) is
itself a could-not-run and is not counted as a pass.

### Deliberately not done

No lane was wired, no assertion weakened, no soft skip opted into, and the
walkthrough's browser logic is untouched — it remains unverified on this host and
is claimed nowhere to be otherwise.
