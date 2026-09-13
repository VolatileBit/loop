# Loop planning contract

Read this before writing specs or implementation issues. Paths below are relative to the repository root.

## Resolve the destination

Read `loop.config.json` and `loop.config.local.json` if present. Local values override tracked values; merge `projects` and `triageLabels` by key. Respect explicit user paths and existing project conventions.

- The default project folder is `specs/<YYYYMMDD>-<project-slug>/`, using the project's local creation date. For example: `specs/20260913-image-previews/`. Reuse an existing folder for the same effort; do not create a new dated folder when continuing work on a later day.
- The spec is `<project-folder>/spec.md`. Implementation issues are `<project-folder>/issues/<NN>-<slug>.md`. Maps and decision tickets live in `<project-folder>/map/` and never become runnable issues.
- The **Loop project ID** is the full folder name, including the date: `20260913-image-previews`. Use it in `projects.<project-id>`, qualified dependency IDs, and CLI commands. The issue container's name `issues` is not the project ID. Keeping the date distinguishes separate efforts that reuse the same descriptive slug.
- For this layout, configure both `issuesDir` and `specsDir` as `specs`: they are scan roots containing project folders, not paths to a single project's `issues/` directory. `loop init` suggests these roots and registers discovered dated project IDs. The planning skills do not change configuration or start a run unless requested.
- Honor explicit custom paths. A custom root such as `planning/features` can contain `planning/features/<YYYYMMDD>-<project-slug>/spec.md` and `issues/`; set both roots to `planning/features`. Existing separate layouts such as `issues/<project-id>/*.md` and `docs/specs/<project-id>.md` still work. Reuse existing issue locations for an established project rather than splitting its backlog between layouts.
- An explicit `projects.<project-id>.spec` selects the spec by repository-relative file path or filename prefix inside `specsDir`. Reuse that document when present. If several specs match, resolve which is authoritative before writing. When a requested destination falls outside the configured issue root, report the required `issuesDir` change in the handoff; `loop init` fills missing roots, while existing roots must be edited explicitly. Do not silently publish invisible issues.
- When a spec exists, put its exact repository-relative path in every issue's `spec:` field. For an issues-only request with no spec, omit `spec` and make each issue self-contained. A spec pointer works independently of `specsDir` and project registration; Loop passes that document to later agent sessions.

Example layout:

```text
specs/20260913-image-previews/
  spec.md
  issues/
    01-upload.md
    02-preview.md
  map/                         # optional planning decisions
```

## Issue format

Each issue starts with plain scalar frontmatter:

```markdown
---
id: 01-upload
title: Accept an image upload
triage: ready
spec: specs/20260913-image-previews/spec.md
---

## What to build

Accept a supported image and return its upload ID.

## Acceptance criteria

- [ ] An upload integration test proves a supported image returns an ID.
- [ ] The same test suite proves unsupported formats return a validation error.

## Blocked by

None
```

Use a stable ID matching the filename stem, unique within the project. Loop reads `id`, `title`, `triage`, and `spec` from frontmatter; a heading or `Status:` line is not a substitute. Scalars are single lines without YAML quoting or multiline syntax: Loop's reader preserves scalar text literally.

Keep the headings `## Blocked by` and `## Acceptance criteria` exactly as shown. Use `- [ ]` checkboxes. Dependencies are bullets containing exact sibling IDs (`- 01-upload`), filenames, or qualified IDs (`- 20260912-shared-assets/01-storage`). Loop matches full IDs or filename stems, not numeric prefixes. Allocate IDs without overwriting existing files and validate that dependencies exist and have no cycles.

## Triage and human work

Read configured `triageLabels` before choosing labels. Defaults are:

| Role | Default label | Use |
|---|---|---|
| `readyForAgent` | `ready` | Approved, independently verifiable implementation work |
| `needsInfo` | `needs-info` | Unresolved decisions prevent implementation |
| `delegatedToHuman` | `delegated` | Work a person has taken on |
| `done` | `done` | Completed work; human blockers require recorded evidence |

A delegated issue is never claimed. Dependents remain blocked until it is `done`. A backlog containing only delegated work is considered settled by Loop; it is still work for the person. Include a `## Done when` section describing evidence for human completion. Do not mark unresolved human work done or weaken another issue's criteria to bypass it.

## Handoff

Report the dated Loop project ID, scan root, project folder and exact issue directory, spec path, any unresolved or delegated work, and the next commands: `loop init`, then `loop run <project-id> --dry-run`. Initialization discovers unregistered project folders and spec candidates; users can accept suggested paths or enter custom ones. Registration adds overrides; Loop can discover issues in its configured root without a `projects` entry.

Loop uses `verifyCmd`, `issuesDir`, `specsDir`, and `projects.<project-id>.spec`. Do not invent `specPath`, `checkCommand`, or per-project `baseBranch` settings. Use repository evidence for suggested verification commands; `loop init` validates the global command entered interactively. Do not start a run or change configuration unless requested.
