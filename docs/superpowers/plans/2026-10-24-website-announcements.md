# Website Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a protected Studio editor for scheduled scrolling announcements and show the active announcement in a full-width strip across all game-site screens.

**Architecture:** Extend the existing `Announcements` service with a revision-checked, atomic update path for scroll entries, preserving popup entries. Add protected Studio read/write routes and a Studio pane; keep the existing WebSocket announcement broadcast and app-level banner, changing only its shared placement and layout.

**Tech Stack:** Node.js ESM, Preact/HTM, existing Studio API and key, shared announcement schema, CSS.

**Spec:** `docs/ANNOUNCEMENT_SYSTEM_DESIGN.md`

## Global Constraints

- Management remains inside Studio and inherits its existing local/LAN gate and `X-SP-Studio` key.
- The banner appears on title, lobby, room, and game screens; Studio itself does not show it.
- Reuse `shared/announcements.js`, the existing config file, and current WebSocket delivery.
- Edit only rolling entries; preserve popup entries and their file-backed bodies.
- Invalid or stale edits must not replace the current config; writes use a same-directory temporary file and atomic rename.
- Do not modify ECS or restart any server.
- Do not add or run automated tests unless the user asks for test/verification work; use code review and a production build check for this implementation.

## Review Focus

- Missing config file or disabled storage: the editor must distinguish an empty editable schedule from unavailable persistence.
- Invalid current config: refuse writes and preserve the last valid live schedule.
- Concurrent edits: a stale revision returns a conflict instead of silently overwriting newer content.
- Existing popup rows, especially `textFile` rows, survive scroll edits unchanged.
- The top strip must not block primary controls, must respect safe areas, and must remain readable with reduced motion enabled.

---

### Task 1: Protected announcement storage API

**Files:**
- Modify: `server/announcements.js`
- Modify: `server/studio/index.js`
- Modify: `server/index.js`
- Modify: `docs/PLUGIN-API.md`

**Interfaces:**
- `GET /studio/api/announcements` returns `{ announcements, revision }`, where `announcements` contains only normalized scroll rows and `revision` identifies the exact current config bytes (or a stable missing-file marker).
- `PUT /studio/api/announcements` accepts `{ announcements, revision }` and returns the updated `{ announcements, revision }`.
- A stale revision returns HTTP 409; missing/disabled storage returns a clear non-success response; invalid combined config returns 400 without writing.
- The Studio API receives the existing `Announcements` instance from `server/index.js`.

- [x] Add an `Announcements` service operation that reads the raw JSON, computes its revision, validates the complete document using the existing loader/parser, and returns normalized scroll rows.
- [x] Add a serialized replace operation that checks the revision, replaces only scroll rows, preserves all popup rows verbatim, validates the combined document, writes through a temporary sibling file and rename, then reloads and broadcasts immediately.
- [x] Add `GET` and `PUT` routes guarded by the existing Studio read/write checks, register them in `STUDIO_ROUTES`, and document the exact request/response contract.
- [x] Inspect the diff for failure-safe behavior, path confinement, bounded request size, and unchanged popup data.

### Task 2: Studio announcement editor

**Files:**
- Create: `public/studio/js/announcements.js`
- Modify: `public/studio/js/main.js`
- Modify: `public/studio/studio.css`
- Modify: `public/i18n/en.json`

**Interfaces:**
- The editor calls `GET /studio/api/announcements` and `PUT /studio/api/announcements` using the existing Studio API helpers.
- The editor manages `id`, `text`, `startAt`, `durationSeconds`, `level`, and `enabled`; its save payload includes the revision returned by GET.

- [x] Add a Studio pane entry and render the editor without changing existing plugin/catalog workflows.
- [x] Add list, create, edit, enable/disable, delete, and preview interactions with existing Studio components/styles.
- [x] Show load/save errors, stale-revision conflicts, and success state; keep edits local until the operator saves.
- [x] Add English strings for new interface labels while keeping Chinese as the source text.
- [ ] Review the page at narrow and wide sizes for usable form controls and scrolling. Static styles were inspected; no browser visual pass was performed.

### Task 3: Shared top announcement strip

**Files:**
- Modify: `public/css/components.css`
- Modify: `public/js/ui/announcement.js` only if the shared layout needs an active-state class or accessibility adjustment.

- [x] Change the existing app-level banner to a full-width top strip, keeping its current active-state, close, dismissal-version, and scrolling behavior.
- [x] Respect `--sa-t`/safe-area insets and ensure screen headers, game controls, connection notices, and toast messages remain usable while a notice is active.
- [x] Keep reduced-motion behavior static and readable; preserve the close control's pointer and keyboard behavior.
- [x] Inspect the full diff and perform a production build check; report that automated tests were not run unless the user requests them.

### Task 4: Integration review and Git record

**Files:**
- Review all files changed by Tasks 1–3.

- [x] Check each design acceptance item against the implementation and fix any gap within the scoped files.
- [x] Run `npm run build` and `git diff --check`; report their exact results.
- [ ] Commit the design, plan, and implementation on `codex/website-announcements` using the repository's noreply commit identity.
- [ ] Do not merge, push, or deploy without a separate user request.
