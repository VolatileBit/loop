---
name: wayfinder
description: Plan a huge chunk of work — more than one agent session can hold — as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear. Run this only when explicitly asked for by name — it is a deliberate, user-initiated workflow, not one to start on your own.
---

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name** — its title. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare id, number, or slug. A wall of `#42, #43, #44` is illegible; names read at a glance. The id and URL don't vanish — a name wraps its link — but they ride *inside* the name, never stand in for it.

## The Map

The map is a single artifact on this repo's issue tracker — the canonical one. Its tickets belong to the map; where both physically live is tracker-specific (below).

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

**Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific.**

### Issue tracker: Local Markdown

Read [the Loop planning contract](../to-spec/references/loop-planning.md) for configured paths and project identity. Wayfinder artifacts live as markdown files under `<specs-directory>/<YYYYMMDD>-<project-slug>/map/`.

**The `map/` and `issues/` directories are siblings inside the dated project folder.** Loop reads only the `issues/` container for a planning project. Map tickets are questions to decide, not slices to implement; never put them in `issues/` or give them runnable triage. Reuse the same dated project folder when the map becomes a spec and issues.

#### Conventions

- The map is `<specs-directory>/<YYYYMMDD>-<project-slug>/map/map.md` — one per effort, and the canonical artifact
- Tickets are `<specs-directory>/<YYYYMMDD>-<project-slug>/map/<NN>-<slug>.md`, numbered from `01`, each starting with a `# NN — <Title>` heading
- Ticket state is a `Status:` line near the top: `open` or `closed`. These are wayfinder's own vocabulary, not Loop's — nothing here is ever labelled `ready`
- The type is a `Type:` line: `research`, `prototype`, `grilling`, or `task`
- A ticket is **claimed** by an `Owner:` line naming the dev driving the map. Open with no `Owner:` line means unclaimed
- Blocking is a `## Blocked by` section listing sibling tickets in this directory (`- [12](./12-slug.md)`). Local markdown has no native dependency links, so this section is the fallback the skill's blocking rules refer to
- A ticket's answer is recorded under a `## Resolution` heading in its own file when it closes
- The **frontier** is every ticket that is `open`, has no `Owner:` line, and whose `## Blocked by` entries are all `closed`. Compute it by reading the directory — there is no query API

#### When this skill says "publish to the issue tracker"

Create a new file under `<specs-directory>/<YYYYMMDD>-<project-slug>/map/` (creating the directory if needed).

#### When this skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the ticket number directly.

#### Handing off to implementation

When the way is clear and the map is done, the destination usually becomes a spec and then issues — run `/to-spec` and `/to-issues`, which write the spec beside `map/` and issues to the sibling `issues/` directory in the same dated project folder. Map tickets never graduate into implementation issues by being renamed or moved; they stay in `map/` as the record of how the route was chosen.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a **child issue** of the map; the tracker's issue id is its identity. Its body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Each ticket declares its type — one of `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)) — however the tracker records it.

A session **claims** a ticket by marking it as owned by the dev driving the map, **first**, before any work, so concurrent sessions skip it. That owner _is_ the claim: an open, unowned ticket is unclaimed.

Blocking uses the tracker's **native** dependency relationship where it has one — it renders the frontier _visually_ in the tracker's own UI, so the human sees what's takeable without opening the map. A tracker that lacks native blocking (local markdown does) falls back to the body convention above. A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed tickets — the edge of the known.

The answer isn't part of the body — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by a **background subagent** — see [Resolving a research ticket](#resolving-a-research-ticket). Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code (via the `/prototype` skill where the repo has it). Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the /grilling and /domain-modeling skills, working the ticket's decision tree in rounds. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

### Resolving a research ticket

Research is the one type that runs unattended and in parallel, so it needs to come back with something another session can trust without redoing the reading. When delegation is available, spin up a **background subagent** per independent research ticket so charting can continue. Otherwise resolve one research ticket directly and record the same evidence. Give the researcher this job:

1. **Investigate against primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it. A fact a decision hangs on is worth the extra hop; a blog post paraphrasing a changelog is not the changelog.
2. **Write the findings to a single Markdown file, citing each claim's source.** An uncited claim is indistinguishable from a guess by the time someone reads it, which defeats the point of having researched it.
3. **Capture it on a throwaway `research/<name>` branch** and leave a context pointer to it from the ticket, so the finding is retrievable without carrying it in anyone's context.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `/grilling` and `/domain-modeling` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map**: Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now**, belonging to the map — then wire blocking edges in a **second pass** (tickets need ids before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just created, spin up a background subagent to resolve it in parallel, following [Resolving a research ticket](#resolving-a-research-ticket).
6. Stop — charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map (URL or number). A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: mark it owned by yourself before any work.
3. Resolve it — **zoom as needed**: fetch the full body of any related or closed ticket on demand; invoke the skills the `## Notes` block names. If in doubt, use `/grilling` and `/domain-modeling`.
4. Record the resolution: write the answer into the ticket as its **resolution**, mark the ticket **closed**, and **append a context pointer** to the map's Decisions-so-far.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.
