---
description: Resume an interrupted task after retry/limit/disconnection
argument-hint: "[task-description]"
---
## Task Resumption Protocol

**Context:** Task was interrupted mid-execution due to model retry, token limit, session timeout, or disconnection. All work done up to this point is valid. Resume from exactly where it stopped.

### Step 1 — Establish Resumption Anchor

Scan the conversation history to determine the last completed action before interruption. Look for:
- Last completed step in a multi-step sequence
- Last line of code written or file edited
- Last command executed and its output
- Last `todo` task marked `in_progress`
- Last error or blocker encountered
- Last user instruction or requirement stated

State the resumption point clearly: "Resuming at: [exact step/line/action]"

### Step 2 — Verify Integrity

Before proceeding, verify that prior work is intact:
- Check that created/modified files still exist and are not corrupted
- Confirm partial outputs (logs, build artifacts, test results) are still valid
- If mid-edit, check that the file is not in a broken state
- If mid-command, check if the command actually completed or needs re-run

### Step 3 — Resume

Continue the interrupted task from the resumption point. Do not restart from the beginning unless the interruption caused data loss or state corruption.

### Step 4 — Report

Briefly state: what was resumed, from where, and any adjustments made due to the interruption.

---

${1:-No specific task description provided. Reconstruct from conversation context above.}