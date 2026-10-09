# Change Log

All notable changes to the "naruto" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
