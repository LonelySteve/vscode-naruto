# Change Log

## [0.3.0] - 2026-10-15

- Validate the required baseline when receiving the starting header and prompt users to switch VS Code items to full mode if it is missing.
- Restore mixed ranges by replacing full-item subtrees and retaining unchanged incremental files.
- Report reception success only after restoring and saving the complete file package.

## [0.2.0] - 2026-10-15

- Persist complete snapshots and restore incremental exports against their matching baseline, including file additions, updates, and deletions.
- Provide a complete directory and ZIP after every successful reception, with independent editable copies that preserve the saved baseline.
- Preserve earlier baselines for retransmission and request a full export when the required baseline is missing.
- Read the app bundle version from package.json when packaging.
