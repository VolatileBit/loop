---
name: eli-layman
description: Explain technical topics to a non-technical audience — leadership, sales, support, finance, customers, friends, family. Use this skill whenever the user asks to explain something "simply", "in plain English", "without jargon", "like I'm five", "for non-technical people", or "so my manager / the CEO / my mum gets it". Also use it when the user is drafting an announcement, status update, incident summary, or pitch aimed at people who don't write code — even if they don't explicitly ask for a simple explanation. Do NOT use this skill when the audience is an engineer; use eli-junior for that.
---

# ELI Layman

Explain it so someone who has never written a line of code understands it in seconds.

## Audience model

They are **smart but unfamiliar**. Assume a sharp adult with zero technical vocabulary.

- Knows: their own job, business outcomes, money, time, risk, customers.
- Does not know: any acronym you use daily, any tool name, anything about how software is built.
- Cares about: what changes for them, what it costs, what breaks, what happens next.
- Will stop reading the moment they hit a word they don't recognise.

Never assume they know a term because it's "basic". API, cache, deploy, repo, endpoint, schema, queue, latency — all of these need replacing, not defining.

## Style

**No walls of text.** Be brief and concise. Use Smart Brevity. Sacrifice grammar for precision where it helps — fragments are fine. The reader should get it within a few seconds.

- Lead with the bottom line. Never build up to it.
- One idea per line. Short lines.
- Bold the lead-in phrase, then the payload.
- Cut every word that isn't load-bearing.
- Concrete over abstract. Numbers over adjectives.

## Format

Adapt to length, but default to this shape:

```
**Bottom line:** [one sentence, plain words, what it is or what happened]

**Why it matters:** [the consequence for them — money, time, risk, customers]

**How it works:** [one analogy from everyday life, 2-3 lines max]

**What's next:** [only if there's an action or a date]
```

Drop any section that isn't needed. Three lines total is a success, not a failure.

## Translating jargon

Replace the term entirely. Don't say the term and then define it.

| Instead of | Say |
|---|---|
| The API was rate-limited | We were only allowed to ask for so much at once |
| We need to migrate the database | We're moving all the records to a new filing system |
| The cache was stale | We were showing people yesterday's numbers |
| Deploying a hotfix | Pushing out an urgent repair |
| It doesn't scale | It works for 100 customers, breaks at 10,000 |

## Analogies

Use them for mechanisms, not for outcomes. One per explanation — stacking analogies is worse than none.

Draw from: post, filing cabinets, restaurants, queues at a counter, plumbing, roads and traffic, keys and locks, staff handovers.

Then stop. Don't extend the analogy past the point it holds up, and don't explain the analogy itself.

## Examples

These are fictional examples. For real incidents, use confirmed facts; do not invent counts, recovery claims, or deadlines.

**Example 1**

Input: Explain our Redis caching layer to the sales team.

Output:
> **Bottom line:** We keep a copy of the answers customers ask for most, so we don't redo the work every time.
>
> **Why it matters:** Pages load in under a second instead of five. Same numbers, less waiting.
>
> **How it works:** Like a barista who pre-makes the popular orders during the morning rush.

**Example 2**

Input: Write an incident update for the exec team about last night's outage.

Output:
> **Bottom line:** Document uploads failed for 90 minutes last night. Nothing was lost.
>
> **Why it matters:** 12 customers hit errors. All uploads have since gone through. No documents are missing.
>
> **Cause:** A routine update to our storage system rejected files above a certain size. We reverted it.
>
> **What's next:** Size check added to our pre-release testing. Done by Friday.

## Failure modes

- **Defining jargon instead of removing it** — "the API (a way for programs to talk)" still costs the reader effort. Cut it.
- **Burying the point** — background first, conclusion last. Invert it.
- **Over-hedging** — "it depends on several factors" tells them nothing. Commit, then caveat in half a line if you must.
- **Explaining how instead of so what** — they rarely need the mechanism. Lead with impact; include mechanism only if asked or if it changes their decision.
- **Condescension** — plain words, not baby talk. No "basically", no "just", no exclamation marks.
