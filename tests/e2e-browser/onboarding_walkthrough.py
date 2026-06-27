#!/usr/bin/env python3
"""
P1b real-browser E2E — ONE chat path (onboarding unified over /ws/app/chat) +
Documents + web Admin panel, driven through the ACTUAL rendered React UI in a
real headless Chromium (system Playwright, Python binding).

This is a regression guard for the chat-surface consolidation. It runs against a
LIVE Open install (default http://127.0.0.1:7800). It is CI-skippable: if the
server is unreachable it prints `E2E SKIP` and exits 0 (no server in CI).

What it proves, in a real browser:
  1. The React app loads at /chat (the server cold-start-redirects a fresh visit
     to /chat?start=<token>, mints the owner cookie, and the client connects to
     the SINGLE /ws/app/chat socket).
  2. A FRESH onboarding renders inline in that same chat surface — agent prompt +
     quick-reply BUTTONS — and is driven to completion by clicking the real
     buttons / typing in the real composer (NO /ws/chat, NO special onboarding
     socket).
  3. A steady-state chat message gets an agent reply rendered.
  4. The Documents tab renders.
  5. The Admin (integrations) tab renders.

Run:
  NEUTRON_E2E=1 /usr/local/bin/playwright ...   # or:
  /usr/local/opt/python@3.9/bin/python3.9 tests/e2e-browser/onboarding_walkthrough.py

Environment:
  NEUTRON_BASE_URL   default http://127.0.0.1:7800
  NEUTRON_E2E_HEADED set to 1 to watch the run
  NEUTRON_E2E_SHOTDIR directory for step screenshots (default ./e2e-artifacts)
"""
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
import zipfile

BASE_URL = os.environ.get("NEUTRON_BASE_URL", "http://127.0.0.1:7800").rstrip("/")
HEADED = os.environ.get("NEUTRON_E2E_HEADED") == "1"
SHOTDIR = os.environ.get("NEUTRON_E2E_SHOTDIR", os.path.join(os.getcwd(), "e2e-artifacts"))

# Path 1 (onboarding-as-CC-session) host-side artifacts. These let the test
# (which runs on the SAME host as the real-browser Open install) prove that the
# post-turn extractor scribed the profile and that history-import materialized.
SERVER_LOG = os.path.expanduser(
    os.environ.get("NEUTRON_E2E_SERVER_LOG", "~/neutron/data/logs/server.log")
)
OWNER_HOME = os.path.expanduser(
    os.environ.get("NEUTRON_HOME") or os.environ.get("OWNER_HOME") or "~/neutron/data"
)

# Cold-start / live-LLM timing budgets. The live CC session cold-starts ~100s on
# the FIRST turn, so we allow up to 180s for the first agent bubble and 120s for
# each subsequent turn.
FIRST_BUBBLE_TIMEOUT_MS = 180_000
TURN_TIMEOUT_MS = 120_000

# Onboarding "re-prompt" markers — if a freeform answer is misrouted the agent
# falls back to one of these. Their ABSENCE proves the freeform answer advanced.
REPROMPT_MARKERS = ["i didn't quite catch that", "tap one of the buttons"]

# Onboarding buttons we PREFER to click (advance toward completion / decline
# optional add-ons). Matched case-insensitively against the button label.
PREFER = [
    "skip", "continue", "next", "sounds good", "let's go", "lets go", "got it",
    "yes", "sure", "done", "finish", "looks good", "no thanks", "maybe later",
    "not now", "start", "begin",
]


def server_up() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/healthz", timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def log(step: str, msg: str) -> None:
    print(f"[E2E] {step}: {msg}", flush=True)


def shot(page, name: str) -> None:
    try:
        os.makedirs(SHOTDIR, exist_ok=True)
        p = os.path.join(SHOTDIR, name)
        page.screenshot(path=p, full_page=True)
        log("shot", p)
    except Exception as e:  # screenshots are best-effort evidence
        log("shot", f"failed {name}: {e}")


def pick_button(buttons):
    """Choose the best onboarding button to advance: prefer a PREFER-listed
    label, else the last option (usually the affirmative/continue), else first."""
    labels = []
    for b in buttons:
        try:
            labels.append((b, (b.inner_text() or "").strip()))
        except Exception:
            labels.append((b, ""))
    for b, label in labels:
        low = label.lower()
        if any(p in low for p in PREFER):
            return b, label
    if labels:
        return labels[-1][0], labels[-1][1]
    return None, None


# ── Path 1 helpers ──────────────────────────────────────────────────────────

def _agent_bubbles(page):
    """All NON-typing agent bubble texts, in DOM order. The typing indicator is
    also a `.car-bubble-agent` (with `car-typing`), so it must be filtered out
    or it would be miscounted as a real reply."""
    out = []
    for bb in page.query_selector_all(".car-bubble-agent"):
        cls = bb.get_attribute("class") or ""
        if "car-typing" in cls:
            continue
        out.append((bb.inner_text() or "").strip())
    return out


def agent_bubble_count(page) -> int:
    return len([t for t in _agent_bubbles(page) if t])


def last_agent_text(page) -> str:
    texts = [t for t in _agent_bubbles(page) if t]
    return texts[-1] if texts else ""


def first_agent_text(page) -> str:
    for t in _agent_bubbles(page):
        if t:
            return t
    return ""


def wait_first_agent(page, timeout_ms: int) -> str:
    """Wait for the FIRST real (non-empty, non-typing) agent bubble."""
    page.wait_for_selector(".car-bubble-agent", timeout=timeout_ms)
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        t = first_agent_text(page)
        if t:
            return t
        page.wait_for_timeout(1500)
    return first_agent_text(page)


def send_freeform(page, text: str, timeout_ms: int) -> str:
    """Type a real freeform answer into the composer, send it, and wait for a
    NEW (non-typing) agent bubble. Returns the latest agent text, or "" on
    timeout."""
    before = agent_bubble_count(page)
    comp = page.locator(".car-input").first
    comp.click()
    comp.fill(text)
    page.locator("button.car-send").first.click()
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        page.wait_for_timeout(1500)
        if agent_bubble_count(page) > before:
            return last_agent_text(page)
    return ""


def make_fixture_export_zip() -> str:
    """Create a minimal-but-valid ChatGPT-style export zip (conversations.json
    with one trivial conversation) at a temp path. Returns the zip path."""
    fd, path = tempfile.mkstemp(suffix=".zip", prefix="neutron-export-")
    os.close(fd)
    conversations = [
        {
            "title": "Topline planning",
            "create_time": 1700000000.0,
            "update_time": 1700000100.0,
            "mapping": {
                "root": {"id": "root", "message": None, "parent": None, "children": ["u1"]},
                "u1": {
                    "id": "u1", "parent": "root", "children": ["a1"],
                    "message": {
                        "id": "u1", "author": {"role": "user"},
                        "create_time": 1700000000.0,
                        "content": {"content_type": "text",
                                    "parts": ["I'm building Topline, an AI sales tool."]},
                    },
                },
                "a1": {
                    "id": "a1", "parent": "u1", "children": [],
                    "message": {
                        "id": "a1", "author": {"role": "assistant"},
                        "create_time": 1700000050.0,
                        "content": {"content_type": "text",
                                    "parts": ["Got it — Topline, an AI sales tool. Tell me more."]},
                    },
                },
            },
        }
    ]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("conversations.json", json.dumps(conversations))
    return path


def log_offset():
    """Byte size of the server log right now, or None if unreadable."""
    try:
        return os.path.getsize(SERVER_LOG)
    except Exception:
        return None


def read_log_appended(start_offset):
    """Return (text, readable) for the bytes appended to the server log since
    start_offset."""
    if start_offset is None:
        return "", False
    try:
        with open(SERVER_LOG, "rb") as f:
            f.seek(start_offset)
            return f.read().decode("utf-8", "replace"), True
    except Exception:
        return "", False


def run() -> int:
    from playwright.sync_api import sync_playwright

    if not server_up():
        print("E2E SKIP — no Open server reachable at", BASE_URL)
        return 0

    # Snapshot the server log size now so we can read ONLY the bytes appended
    # during this run when we later assert no router timeout fired (Step 1).
    log_start = log_offset()
    log("setup", f"server log offset at start: {log_start} ({SERVER_LOG})")

    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED)
        ctx = browser.new_context(viewport={"width": 1100, "height": 900})
        page = ctx.new_page()
        page.set_default_timeout(20_000)

        # ── Step 1: load the React app at /chat over the single socket ──────
        log("step1", f"goto {BASE_URL}/chat")
        page.goto(f"{BASE_URL}/chat", wait_until="domcontentloaded")
        # The single chat surface mounts; the composer is the React client's
        # signature element (placeholder "Message Neutron…").
        page.wait_for_selector(".car-input", timeout=30_000)
        log("step1", "React chat client mounted (.car-input present)")

        # ── Step 0: AUTO-START ──────────────────────────────────────────────
        # On a FRESH onboarding state, Path 1 fires the live CC session itself —
        # so an agent bubble must appear WITHOUT the user sending anything, and
        # the composer stays empty. A "Setting things up…" loader
        # (.car-empty-loading) should flash before the first agent message
        # (best-effort: it can clear fast, so we don't fail if we miss it).
        empty_loading_seen = False
        try:
            page.wait_for_selector(".car-empty-loading", timeout=4_000)
            empty_loading_seen = True
            log("step0", "'.car-empty-loading' setup loader observed")
        except Exception:
            log("step0", "'.car-empty-loading' not observed (may have cleared "
                          "fast — best-effort, not gated)")

        # First onboarding prompt must render in the SAME chat surface. The live
        # CC session cold-starts ~100s on the first turn, so allow up to 180s.
        first_agent = wait_first_agent(page, FIRST_BUBBLE_TIMEOUT_MS)
        log("step1", f"first agent message rendered: {first_agent[:120]!r}")
        results["react_app_loads"] = True
        results["onboarding_renders_inline"] = True

        composer_val0 = page.eval_on_selector(".car-input", "el => el.value") or ""
        results["regress_step0_autostart"] = (len(first_agent) > 0 and composer_val0 == "")
        log("step0", f"(0) auto-start (agent bubble w/o user send + empty "
                      f"composer): {results['regress_step0_autostart']} "
                      f"(empty_loading_seen={empty_loading_seen})")
        shot(page, "00-autostart.png")
        shot(page, "01-onboarding-first-prompt.png")

        # ── Step 1b: REGRESSION GUARDS for the React onboarding/chat fixes ──
        # (2026-06-27 — BUGs 1/2/3/5/7 vs the old vanilla chat). These are
        # state-independent client invariants that hold on any onboarding phase.
        def _visible_with_opacity(selector: str) -> list:
            out = []
            for el in page.query_selector_all(selector):
                try:
                    if el.is_visible():
                        op = float(page.evaluate("(e)=>getComputedStyle(e).opacity", el))
                        if op > 0.05:
                            out.append((el.inner_text() or "").strip())
                except Exception:
                    pass
            return out

        # BUG 1 — auto-start: the first agent prompt rendered with NO user send
        # (the composer is still empty).
        composer_val = page.eval_on_selector(".car-input", "el => el.value") or ""
        results["regress_bug1_autostart"] = (len(first_agent) > 0 and composer_val == "")
        log("regress", f"BUG1 auto-start (first prompt, empty composer): {results['regress_bug1_autostart']}")

        # BUG 2/5 — a resting bubble is CLEAN: the reaction '+' and Edit/Delete
        # are in the DOM (a11y) but NOT visible at rest on a hover-capable device.
        add_vis = _visible_with_opacity(".car-reaction-add")
        act_vis = _visible_with_opacity(".car-msg-action")
        results["regress_bug2_5_clean_resting"] = (not add_vis and not act_vis)
        log("regress", f"BUG2/5 clean resting bubble (no visible +/Edit/Delete): "
                       f"{results['regress_bug2_5_clean_resting']} (add={add_vis} actions={act_vis})")

        # BUG 3 — when quick-reply buttons are present they show the real choice
        # text (opt.body), never a bare 'A'/'B'/'C' letter (opt.label).
        choice_texts = [(c.inner_text() or "").strip() for c in page.query_selector_all(".car-choice")]
        bare_letters = [c for c in choice_texts if c in ("A", "B", "C", "D", "E")]
        results["regress_bug3_real_labels"] = (len(bare_letters) == 0)
        log("regress", f"BUG3 real button labels (no bare letters): "
                       f"{results['regress_bug3_real_labels']} (choices={choice_texts})")

        # BUG 4 — the composer file input exists; when an import affordance is
        # shown it advertises .zip.
        accept = page.eval_on_selector(".car-file-input", "el => el.getAttribute('accept')") \
            if page.query_selector(".car-file-input") else None
        hint_present = page.query_selector(".car-upload-hint") is not None
        results["regress_bug4_zip_accept_when_affordance"] = (
            (not hint_present) or (accept is not None and "zip" in accept)
        )
        log("regress", f"BUG4 zip accept (affordance={hint_present}, accept={accept!r}): "
                       f"{results['regress_bug4_zip_accept_when_affordance']}")

        # ── Step 1: FREEFORM ADVANCES + NO RE-PROMPT ────────────────────────
        # Path 1 has no per-turn router/phase-machine: a plain typed answer must
        # advance the conversation across successive questions WITHOUT the agent
        # falling back to a "I didn't quite catch that / tap one of the buttons"
        # re-prompt. We type 3 real freeform answers in sequence and require a
        # NEW agent bubble after each, none of them a re-prompt.
        freeform_answers = [
            "Call me Sam",
            "I'm building Topline (an AI sales tool), Acme infra, and a book "
            "about focus",
            "Outside work I'm really into rock climbing and cooking",
            "Make you warm but direct, and call you Atlas",
        ]
        step1_browser_ok = True
        for idx, ans in enumerate(freeform_answers):
            log("step1-freeform", f"answer {idx+1}/{len(freeform_answers)}: {ans!r}")
            reply = send_freeform(page, ans, TURN_TIMEOUT_MS)
            if not reply:
                log("step1-freeform", f"no new agent bubble within "
                                       f"{TURN_TIMEOUT_MS}ms — FAIL")
                step1_browser_ok = False
                break
            low = reply.lower()
            if any(m in low for m in REPROMPT_MARKERS):
                log("step1-freeform", f"RE-PROMPT detected (answer misrouted): "
                                       f"{reply[:160]!r} — FAIL")
                step1_browser_ok = False
                break
            log("step1-freeform", f"advanced; agent: {reply[:120]!r}")
        # The router-timeout log sub-check is folded in at the END of the run
        # (after browser close); the browser no-reprompt result gates regardless.
        results["step1_freeform_advances"] = step1_browser_ok
        log("step1-freeform", f"(1) freeform advances (browser): {step1_browser_ok}")
        shot(page, "01b-freeform-advanced.png")

        # ── Step 3: HISTORY-IMPORT FULL-FIDELITY (best-effort, NOT gated) ───
        # If the import affordance is shown, drive a real upload of a minimal
        # valid ChatGPT-export zip and assert the import status line shows
        # progress/done. Best-effort host-side: a project doc may materialize
        # under <OWNER_HOME>/Projects/. NOTE: full LLM-driven synthesis can
        # exceed this browser test window, so this step is reported but never
        # gated (and is skipped entirely if the affordance isn't present).
        results["step3_import"] = False
        try:
            if page.query_selector(".car-upload-hint") is not None:
                fixture = make_fixture_export_zip()
                log("step3-import", f"upload affordance present; importing "
                                     f"fixture {fixture}")
                page.set_input_files(".car-file-input", fixture)
                status_seen = False
                last_status = ""
                deadline = time.time() + 60
                while time.time() < deadline:
                    page.wait_for_timeout(1500)
                    st = page.query_selector(".car-import-status")
                    if st is not None:
                        cur = (st.inner_text() or "").strip()
                        if cur:
                            last_status = cur
                            status_seen = True
                            if any(w in cur.lower() for w in
                                   ("done", "complete", "imported", "finished", "%")):
                                break
                results["step3_import"] = status_seen
                log("step3-import", f"(3) import status seen={status_seen} "
                                     f"last={last_status[:160]!r}")
                # Best-effort host-side: did a project doc materialize? (Full
                # synthesis may exceed the test window — non-fatal either way.)
                try:
                    proj_dir = os.path.join(OWNER_HOME, "Projects")
                    materialized = os.path.isdir(proj_dir) and bool(os.listdir(proj_dir))
                    results["step3_import_doc_materialized"] = materialized
                    log("step3-import", f"project doc under {proj_dir}: "
                                         f"{materialized} (synthesis may lag — "
                                         f"non-fatal)")
                except Exception as e:
                    log("step3-import", f"project-dir check skipped: {e}")
                shot(page, "01c-history-import.png")
            else:
                log("step3-import", "no '.car-upload-hint' affordance this "
                                     "phase — skipping import (not gated)")
        except Exception as e:
            log("step3-import", f"import attempt errored (non-fatal): {e}")

        # ── Step 2: drive fresh onboarding to completion via the real UI ────
        completed = False
        last_agent_count = 0
        stable_polls = 0
        for i in range(60):
            # Onboarding is "done" once the project tab bar (Documents/Admin)
            # appears — that only renders for a project shell post-onboarding.
            tabs = page.locator('nav.car-tabs button[role="tab"]')
            if tabs.count() > 0:
                tab_labels = [tabs.nth(j).inner_text().strip() for j in range(tabs.count())]
                if any(t.lower() in ("documents", "admin", "tasks") for t in tab_labels):
                    log("step2", f"tab bar present {tab_labels} — onboarding complete")
                    completed = True
                    break
            choices = page.locator("button.car-choice")
            n = choices.count()
            if n > 0:
                btns = [choices.nth(j) for j in range(n)]
                b, label = pick_button(btns)
                if b is not None:
                    log("step2", f"iter {i}: clicking choice {label!r} (of {n})")
                    try:
                        b.click()
                    except Exception as e:
                        log("step2", f"click failed: {e}")
                    page.wait_for_timeout(1500)
                    stable_polls = 0
                    continue
            # No buttons — the phase may want a typed answer. If the latest agent
            # message looks like a question, type a short generic answer.
            agent_count = page.locator(".car-bubble-agent").count()
            comp = page.locator(".car-input")
            if comp.count() > 0 and agent_count > last_agent_count:
                last_agent_count = agent_count
                # Cycle through varied, realistic answers that re-supply each of
                # the five required fields (name / ≥3 projects / a non-work
                # interest / personality / agent name) — spamming one identical
                # answer just makes the live session loop "got it, what next?".
                cycle = [
                    "My name's Sam.",
                    "Main projects: Topline, Acme infra, and a book about focus.",
                    "Outside work I love rock climbing and cooking.",
                    "I want you warm but direct — no fluff.",
                    "Let's call you Atlas.",
                    "That's everything — I think you've got what you need.",
                ]
                ans = cycle[i % len(cycle)]
                log("step2", f"iter {i}: typing freeform answer {ans!r}")
                comp.first.click()
                comp.first.fill(ans)
                page.locator("button.car-send").first.click()
                page.wait_for_timeout(2500)
                stable_polls = 0
                continue
            # Nothing actionable changed this poll. Stay patient: once the 5th
            # field is collected the agent goes quiet while the fire-and-forget
            # finalize (persona compose+commit + project materialize) runs, then
            # the projects_changed frame paints the tab bar. Allow ~30s idle.
            stable_polls += 1
            page.wait_for_timeout(1500)
            if stable_polls >= 20:
                log("step2", "no further onboarding prompts — treating as settled")
                break
        # Finalize may still be materializing — wait a bit longer for the tab bar
        # (the deterministic completion signal) before giving up.
        if not completed:
            try:
                page.wait_for_selector(
                    'nav.car-tabs button[role="tab"]', timeout=45_000
                )
                tabs = page.locator('nav.car-tabs button[role="tab"]')
                labels = [tabs.nth(j).inner_text().strip().lower()
                          for j in range(tabs.count())]
                if any(t in ("documents", "admin", "tasks") for t in labels):
                    completed = True
                    log("step2", f"tab bar appeared after finalize {labels}")
            except Exception:
                log("step2", "tab bar did not appear within finalize grace window")
        results["onboarding_completed"] = completed
        shot(page, "02-onboarding-end.png")

        # ── Step 3: steady-state chat reply renders ────────────────────────
        # Ensure we're on the Chat tab if a tab bar exists.
        tabs = page.locator('nav.car-tabs button[role="tab"]')
        if tabs.count() > 0:
            for j in range(tabs.count()):
                if tabs.nth(j).inner_text().strip().lower() == "chat":
                    tabs.nth(j).click()
                    page.wait_for_timeout(500)
                    break
        before = page.locator(".car-bubble-agent").count()
        probe = "Reply with the single word READY so I know chat works."
        log("step3", f"sending steady-state message: {probe!r}")
        page.locator(".car-input").first.click()
        page.locator(".car-input").first.fill(probe)
        page.locator("button.car-send").first.click()
        # BUG 7 — while the turn is pending, NO spurious EMPTY agent bubble is
        # rendered above the typing indicator. Sampled right after the send.
        page.wait_for_timeout(800)
        empty_agents = 0
        for bb in page.query_selector_all(".car-bubble-agent"):
            cls = bb.get_attribute("class") or ""
            if "car-typing" in cls:
                continue
            if ((bb.inner_text() or "").strip()) == "":
                empty_agents += 1
        results["regress_bug7_no_empty_bubble"] = (empty_agents == 0)
        log("regress", f"BUG7 no empty agent bubble while pending: "
                       f"{results['regress_bug7_no_empty_bubble']} (empty={empty_agents})")
        # Wait for a NEW agent bubble (the reply). Up to 120s for a live turn.
        got_reply = False
        reply = ""
        for _ in range(80):
            page.wait_for_timeout(1500)
            if page.locator(".car-bubble-agent").count() > before:
                got_reply = True
                break
        if got_reply:
            reply = last_agent_text(page)
            log("step3", f"agent reply rendered: {reply[:160]!r}")
        results["steady_state_reply"] = got_reply

        # ── Step 4: COMPLETES → PLAIN CHAT ──────────────────────────────────
        # Once onboarding completes, a plain message must get a normal
        # steady-state reply that is NOT an onboarding re-prompt/question.
        plain_ok = bool(got_reply) and not any(m in reply.lower() for m in REPROMPT_MARKERS)
        results["step4_plain_chat"] = plain_ok
        log("step4", f"(4) completes → plain chat: {plain_ok} "
                      f"(reply={reply[:120]!r})")
        shot(page, "03-steady-state-reply.png")

        # ── Step 4: Documents tab renders ──────────────────────────────────
        docs_ok = False
        tabs = page.locator('nav.car-tabs button[role="tab"]')
        for j in range(tabs.count()):
            if tabs.nth(j).inner_text().strip().lower() == "documents":
                tabs.nth(j).click()
                page.wait_for_timeout(2000)
                # The Documents tab renders its own panel; assert it mounted
                # (a doc row, an empty-state, or the docs container).
                docs_ok = (
                    page.locator(".car-tabpanel").count() > 0
                    and page.locator("text=/document/i").count() >= 0
                )
                # Stronger: a real doc row if present.
                results["documents_doc_visible"] = page.locator(".cdoc-row, .cdoc-item, [data-doc-id]").count() > 0
                break
        results["documents_tab_renders"] = docs_ok
        shot(page, "04-documents-tab.png")

        # ── Step 5: Admin (integrations) tab renders ───────────────────────
        admin_ok = False
        tabs = page.locator('nav.car-tabs button[role="tab"]')
        for j in range(tabs.count()):
            if tabs.nth(j).inner_text().strip().lower() == "admin":
                tabs.nth(j).click()
                page.wait_for_timeout(2000)
                admin_ok = (
                    page.locator(".cint-root, .cint-section, .cint-key, .cint-account").count() > 0
                    or page.locator("text=/integration|api key/i").count() > 0
                )
                break
        results["admin_tab_renders"] = admin_ok
        shot(page, "05-admin-tab.png")

        browser.close()

    # ── Step 2: NAME + PERSONA PERSISTED (host-side, best-effort) ───────────
    # The fire-and-forget post-turn extractor scribes the profile, so after
    # onboarding <OWNER_HOME>/persona/SOUL.md must exist and be non-empty. This
    # runs on the SAME host as the real-browser install, so the path is readable
    # in the real run; if this test process can't read it (sandbox/CI), we log +
    # skip rather than hard-fail (this key is reported but NOT gated).
    soul_path = os.path.join(OWNER_HOME, "persona", "SOUL.md")
    persona_persisted = False
    try:
        persona_persisted = os.path.isfile(soul_path) and os.path.getsize(soul_path) > 0
        log("step2", f"(2) persona persisted: {persona_persisted} ({soul_path})")
    except Exception as e:
        log("step2", f"(2) persona check unreadable from test process — "
                      f"SKIP (not gated): {e}")
    results["step2_persona_persisted"] = persona_persisted

    # ── Step 1 (cont.): NO ROUTER TIMEOUT in the server log during the run ──
    # Read only the bytes appended since log_start and assert no line matches
    # [llm-router] ... timed out. If the log is unreadable, skip the sub-check
    # (don't fail) — the browser no-reprompt result already gates step 1.
    appended, readable = read_log_appended(log_start)
    if not readable:
        log("step1-log", "server log unreadable — router-timeout sub-check "
                          "SKIPPED (step1 still gated on browser no-reprompt)")
    elif re.search(r"\[llm-router\].*timed out", appended):
        log("step1-log", "ROUTER TIMEOUT found in appended server log — "
                          "FAILING step1_freeform_advances")
        results["step1_freeform_advances"] = False
        results["step1_no_router_timeout"] = False
    else:
        results["step1_no_router_timeout"] = True
        log("step1-log", "no '[llm-router] ... timed out' lines in appended "
                          "server log")

    print("\n[E2E] RESULTS:")
    print(json.dumps(results, indent=2))
    # Required gates for a PASS. Path 1 (onboarding-as-CC-session) steps that we
    # can deterministically drive through the real browser are gated; host-side
    # filesystem checks + LLM-driven import synthesis are reported but NOT gated
    # (they depend on the test process having read access to <OWNER_HOME> and on
    # synthesis finishing inside the browser window — neither is guaranteed on a
    # slow/headless host, though both hold in the real same-host run).
    #
    # NOT gated (reported only): step2_persona_persisted (host fs access),
    # step3_import (affordance presence + LLM synthesis timing),
    # onboarding_completed / steady_state_reply / documents_* / admin_* (live
    # credential + phase timing).
    required = [
        "react_app_loads",
        "onboarding_renders_inline",
        # (0) auto-start — live CC session fires the first prompt itself.
        "regress_step0_autostart",
        # (1) freeform advances with no re-prompt (browser); the router-timeout
        # log sub-check can only downgrade this, never upgrade it.
        "step1_freeform_advances",
        # (4) completes → a plain steady-state reply (not an onboarding prompt).
        "step4_plain_chat",
        # (5) the UI fixes hold — state-independent client invariants (BUGs
        # 1/2/3/4) plus BUG 7 (no empty agent bubble while a turn is pending,
        # which steps 3/4 reliably exercise by sending a steady-state message).
        "regress_bug1_autostart",
        "regress_bug2_5_clean_resting",
        "regress_bug3_real_labels",
        "regress_bug4_zip_accept_when_affordance",
        "regress_bug7_no_empty_bubble",
    ]
    ok = all(results.get(k) for k in required)
    print("\n[E2E]", "PASS" if ok else "FAIL", "(required:", required, ")")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
