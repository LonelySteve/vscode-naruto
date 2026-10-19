# Change Log

All notable changes to the "naruto" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.5.1] - 2026-10-19

- Keep rename and delete hidden on workspace root nodes by using a when-clause condition form supported by VS Code 1.72.

## [0.5.0] - 2026-10-15

- Add persistent insertion-order and natural Explorer-style sorting for virtual workspace roots.
- Add filename filtering with case sensitivity, whole-word matching and regular expression controls, including live preview and invalid-pattern validation.
- Clear tree selection when opening the filter and restrict filtered exports to matching files, preserving ancestor folders in the view.
- Keep filter, import and export actions in the title bar; move sorting, creation, refresh and clear actions into the native More menu.

## [0.4.0] - 2026-10-15

- Export the highlighted file/folder range from selected item buttons or the title button, deduplicating overlapping selections.
- Persist per-item full/incremental modes, allow mixed ranges, and mark incremental items with a leading icon.
- Include baseline identifiers in the starting header so the Mac receiver can reject missing copies before receiving data blocks.
- Record baseline-independent full copies automatically after the final clipboard write; keep reception confirmation for incremental and mixed copies that depend on a baseline.

## [0.3.0] - 2026-10-15

- Export file changes incrementally against the last manually confirmed snapshot, with a full export command for initial transfer and resynchronization.
- Track independent baselines for the selected workspace and individual nodes, including unsaved text edits.
- Add a setting to control deletion of resources removed from the virtual workspace, enabled by default.
- Include snapshot identifiers so the updated Mac receiver can restore a complete file package from its saved baseline.

## [0.2.3] - 2026-10-14

- Add an inline export button to every virtual workspace file and folder, preserving workspace paths and excluded descendants.
- Continue chunked export when clicking the same node, and start a new snapshot when switching nodes.

## [0.2.2] - 2026-10-09

- Lower the minimum supported VS Code version to 1.72.0 and pin the VS Code API types to the same version.

## [0.2.1] - 2026-09-21

- Add a virtual workspace clear action and command with confirmation, preserving real files and cancelling the current export.
- Add file tab context menu actions for adding and removing virtual workspace selections.
- Show add or remove actions in file tab and Explorer menus based on workspace membership, including selected descendants and exclusions.

## [0.2.0] - 2026-09-21

- Move the VS Code extension into `packages/vscode-naruto` in a pnpm workspace.
- Add a companion native macOS receiver for automatic clipboard export collection, file extraction, and ZIP copying.
- Preserve the version 1 export protocol and existing extension commands and settings.

## [0.1.0]

- Initial release
