/**
 * @neutronai/landing — the LOCKED accept-time data-locality disclosure + write-
 * access caution, UNIFIED across all collaborators (connect-trust-class-collapse).
 *
 * Shared by every accept surface (the by-link token accept page,
 * connect-accept.ts; and the by-email OAuth accept, invite.ts). The disclosure is
 * MANDATORY and pre-accept. There is ONE disclosure — it does NOT branch on how a
 * collaborator is hosted (Managed vs Neutron Open). Hosting shape is an
 * authentication-mechanism detail, never a tier, so it must not produce a
 * scarier-for-self-hosters warning. The Accept button stays DISABLED until the
 * acknowledgement checkbox this renders is checked (the page wires the gate to
 * the returned checkbox).
 *
 * The disclosure keys on the axes that are actually about safety, all
 * hosting-independent:
 *   - trust lead-in: "Only accept invite links from people you trust." — about
 *     the INVITE, not the hosting, so it applies to EVERY collaborator. Calm but
 *     firm; deliberately NOT a loud red/amber alert (it is shown to everyone, so
 *     an alarm treatment would just train people to ignore it).
 *   - data-locality: project name, who hosts, who can see (always rendered).
 *   - scope: write vs read. The write-scope caution is the ONE conditional,
 *     higher-stakes warning, so it keeps the warm-amber treatment — that is where
 *     the visual weight belongs, not on the always-on lead-in.
 *
 * SECURITY (brief § 5 #8): every value here (project name, owner display, host)
 * is an UNTRUSTED string rendered as TEXT via `textContent` — never as markup,
 * never fed to an agent tool. The values are RESOLVED from the invite-preview /
 * JWT context (never a hardcoded placeholder — test #5).
 *
 * Framework-free DOM so it runs identically in jsdom tests and the browser.
 */

export interface DisclosureContext {
  /** Resolved project display name. */
  projectName: string
  /** Resolved owner display (whose instance hosts this). */
  ownerDisplay: string
  /** Resolved connect host (e.g. `connect.example.com`). */
  connectHost: string
  /** Resolved project privacy tier: 'private' | 'instance' | 'public'. */
  privacyTier: string
  /** Resolved GBrain scope this invite grants. */
  scope: 'write' | 'read'
}

export interface RenderedDisclosure {
  /** The acknowledgement checkbox the page gates the Accept button on. */
  checkbox: HTMLInputElement
}

/**
 * Render the unified disclosure into `host`, returning the acknowledgement
 * checkbox. Idempotent: clears `host` first so a re-render (preview re-fetch)
 * replaces rather than appends.
 */
export function renderDisclosure(
  host: HTMLElement,
  ctx: DisclosureContext,
): RenderedDisclosure {
  const doc = host.ownerDocument
  host.replaceChildren()

  // Always-on trust lead-in — calm but firm. Keys on the INVITE (which is what
  // the recipient actually has to vet), not on where anyone is hosted.
  const trust = el(doc, 'div', 'disclosure-trust')
  trust.append(
    textEl(
      doc,
      'p',
      'disclosure-trust__lede',
      'Only accept invite links from people you trust.',
    ),
    textEl(
      doc,
      'p',
      'disclosure-trust__body',
      `This link connects you to someone else’s project, running on their instance. Review the details below before you join.`,
    ),
  )
  host.append(trust)

  // Always-disclosed data-locality block (every collaborator, same copy).
  const facts = el(doc, 'dl', 'disclosure-facts')
  appendFact(doc, facts, 'Project', ctx.projectName)
  appendFact(doc, facts, 'Hosted by', `${ctx.ownerDisplay} · ${ctx.connectHost}`)
  appendFact(
    doc,
    facts,
    'Who can see it',
    `${ctx.ownerDisplay}'s operator runs the project and can see what you contribute.`,
  )
  if (ctx.privacyTier === 'private') {
    appendFact(
      doc,
      facts,
      'Privacy',
      `This is a private project. It runs on ${ctx.ownerDisplay}'s substrate and privacy tier — not yours.`,
    )
  }
  host.append(facts)

  // Write-access caution (write scope only) — the ONE conditional, higher-stakes
  // warning, so it carries the visual weight (warm-amber treatment in the page
  // CSS). Read members persist nothing.
  if (ctx.scope === 'write') {
    const warn = el(doc, 'div', 'disclosure-write')
    warn.append(
      textEl(doc, 'p', 'disclosure-write__lede', 'This invite grants write access.'),
      textEl(
        doc,
        'p',
        'disclosure-write__body',
        `Content you contribute can be persisted into ${ctx.ownerDisplay}'s project memory — provenance-tagged, source-isolated, and retractable by the owner.`,
      ),
    )
    host.append(warn)
  } else {
    host.append(
      textEl(
        doc,
        'p',
        'disclosure-read',
        'Read access only — nothing you do is written into the owner’s project memory.',
      ),
    )
  }

  // Acknowledgement gate. The Accept button stays disabled until this is checked.
  const ackRow = el(doc, 'label', 'disclosure-ack')
  ackRow.setAttribute('for', 'ack-disclosure')
  const checkbox = doc.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.id = 'ack-disclosure'
  checkbox.className = 'disclosure-ack__box'
  ackRow.append(
    checkbox,
    textEl(
      doc,
      'span',
      'disclosure-ack__text',
      `I understand where this project lives and accept the above.`,
    ),
  )
  host.append(ackRow)

  return { checkbox }
}

function el(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag)
  node.className = className
  return node
}

function textEl(doc: Document, tag: string, className: string, text: string): HTMLElement {
  const node = el(doc, tag, className)
  node.textContent = text
  return node
}

function appendFact(doc: Document, dl: HTMLElement, term: string, value: string): void {
  dl.append(textEl(doc, 'dt', 'disclosure-facts__term', term), textEl(doc, 'dd', 'disclosure-facts__val', value))
}
