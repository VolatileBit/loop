---
name: eli-junior
description: Explain a system, service, repo, or domain concept to an engineer who is new to it — a fresh junior, a new hire, or someone rotating onto the team. Assumes coding competence but zero project context. Use this skill whenever the user asks to explain something "for a junior engineer", "for a new hire", "for onboarding", "assume I've never seen this codebase", "walk me through this service", or asks for a handover, orientation, or ramp-up doc. Also use it when the user is writing onboarding notes, a README intro, or an architecture overview for teammates. Do NOT strip technical vocabulary — if the audience is non-technical, use eli-layman instead.
---

# ELI Junior

Explain it to a competent engineer who has never seen this system.

## Audience model

They can code. They cannot read your mind.

**Assume they know:** programming, git, HTTP, JSON, SQL basics, testing, debugging, reading stack traces, general cloud concepts.

**Assume they do not know:** your domain, your acronyms, your service names, your table names, your team's conventions, why any past decision was made, which of the twelve similarly-named modules is the real one.

The gap is **context, not capability**. Don't teach them what a queue is. Tell them which queue, why it's there, and what happens when it backs up.

## Style

**No walls of text.** Be brief and concise. Use Smart Brevity. Sacrifice grammar for precision where it helps — fragments are fine. The reader should get the shape of it within a few seconds, then be able to go deeper.

- Lead with what it is, in one line.
- One idea per line. Short lines.
- Bold the lead-in phrase, then the payload.
- Name real things: file paths, service names, env vars, table names, function names.
- Prefer a 6-line data flow over a paragraph of prose.

## Format

Adapt to the question, but default to this shape:

```
**What it is:** [one line]

**Why it exists:** [the problem it solves — what was broken or manual before]

**How it fits:** [data flow, arrows, 3-6 steps]

**Where the code is:** [paths, entry points, the one file to read first]

**Gotchas:** [the things that will waste their afternoon]

**Read next:** [1-3 pointers]
```

Drop sections that don't apply. For a narrow question, answer the question — don't force the full template.

## Rules that matter most

**Define domain jargon inline, on first use.** Parenthetical, short.
> Retention period (how long an uploaded file is kept before automatic deletion) is stored on `uploads.retention_days`.

**Give the data flow, not the class diagram.** New engineers orient by following a request.
> `POST /uploads` → validated in `handlers/upload.go` → row into `uploads` → publishes `upload.created` → `thumbnailer` worker picks it up → writes previews to object storage.

**Say where to start reading.** One file. Not "the codebase".

**Include the why behind odd choices.** Weird code with a stated reason is learnable; weird code without one gets "fixed" and breaks production.
> The retry loop looks redundant — the upstream image-processing API returns 200 with an error body, so we can't rely on status codes.

**Distinguish load-bearing from incidental.** Say which parts are legacy, which are being replaced, which are safe to ignore.

## Examples

These are fictional examples. Use verified names, paths, timings, and limits from the actual system when explaining real work.

**Example 1**

Input: Explain our image upload service to someone starting Monday.

Output:
> **What it is:** Background service that creates small previews of uploaded images.
>
> **Why it exists:** Original images can take seconds to download. Previews keep the gallery fast without changing the originals.
>
> **How it fits:**
> 1. Image uploaded → `uploads` table, status `pending`
> 2. `upload.created` published to the job queue
> 3. `thumbnailer` worker checks the format and creates a preview
> 4. Preview saved to object storage; upload marked `ready`
> 5. Unsupported images marked `failed` with a reason the UI can show
>
> **Where the code is:** `services/thumbnailer/`. Start at `worker.go:Handle()` — the whole flow is visible from there.
>
> **Gotchas:**
> - Jobs can arrive twice. Preview writes use the upload ID as the storage key so retries replace the same object.
> - Local development needs the storage emulator running or every job fails at the save step.
>
> **Read next:** `docs/image-formats.md`, then `internal/uploads/status.go`.

**Example 2**

Input: New grad asked me what idempotency keys are for in our job submission code.

Output:
> **What it is:** A caller-supplied unique string on write requests. Same key twice = we return the first result instead of doing the work again.
>
> **Why it exists:** Clients retry on timeout. Without keys, a timed-out job submission that actually succeeded creates two jobs.
>
> **How it works here:** Key goes in the `Idempotency-Key` header → looked up in `idempotency_records` (keyed by key + endpoint) → hit returns the stored response, miss proceeds and stores the result in the same transaction as the write.
>
> **Gotcha:** Records expire after 24h. Retries beyond that will double-execute. Fine for our clients, not something to rely on.
>
> **Where:** `middleware/idempotency.go`.

## Failure modes

- **Teaching general CS** — they know what a hash map is. Skip it.
- **Vague pointers** — "it's in the API layer" is not a location. Give the path.
- **Listing components without connecting them** — a component inventory doesn't tell them how a request flows. Flow beats inventory.
- **Silent jargon** — an undefined internal acronym stalls the reader completely. Define on first use.
- **Omitting the why** — without it they can't tell intentional from accidental.
- **Dumping everything** — orientation first, depth on request. Point to the deeper doc instead of inlining it.
