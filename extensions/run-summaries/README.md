# Run Summaries Extension for Pi

Automatically generates compact terminal recaps and actionable next steps in Bahasa Indonesia when a main-agent run settles.

## Features

- **Settled Run Recaps:** Generates bulleted summaries and next steps once the main run is completely settled.
- **Privacy & Redaction:** Automatically redacts common tokens, private keys, authorization headers, and excludes `!!` (`excludeFromContext`) shell runs.
- **Race Condition Protection:** Validates that the active session and leaf haven't changed while summarizing before appending custom entries.
- **Scoped Model Selection:** `/summary-model` dashboard honors active model scopes and prevents terminal overflow on narrow terminals.
- **Standard Config Storage:** Persists private preferences to `~/.pi/agent/run-summaries.config.json`.

## Configuration

Run `/summary-model` in interactive TUI mode to select the model and reasoning level.
