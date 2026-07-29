# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately. Do NOT open a public GitHub
issue for a security problem.

- Use GitHub's private vulnerability reporting: the "Report a vulnerability"
  button under this repository's **Security** tab, or
- Email **ryan@junee.org** with the details.

Please include: a description of the issue, the impact, and a reproduction or
proof of concept if you have one.

We will acknowledge your report as soon as we can and keep you updated on the
fix. Please give us a reasonable window to address the issue before any public
disclosure.

## Scope and context

Neutron is an agent harness that runs Claude Code sessions on YOUR machine,
under YOUR Claude credentials. A few things worth knowing when assessing
security:

- Neutron runs `claude` with broad permissions on the host it is installed on,
  by design. Treat the machine running Neutron as trusted infrastructure.
- Your Claude OAuth token / API key lives in your local `.env`
  (`<install dir>/core/.env`). Never commit it. Secret scanning + push
  protection are enabled on this repo to help prevent accidental key commits.
- The self-host web app is intended to be bound to localhost (or fronted by your
  own TLS-terminating reverse proxy). Do not expose the raw onboarding/chat port
  to the public internet without auth in front of it.

## Supported versions

Neutron is pre-release. Security fixes land on the default branch (`main`).
There are no long-term support branches yet.
