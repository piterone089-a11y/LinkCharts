# Releasing

Every version is a git tag (`v1.3.2`) whose commit message is the release notes. That same text is
what the app shows under **What's new** and what the GitHub release says, so write it for users.

## Cut a release

1. **Write the notes** — add a `## [x.y.z] - YYYY-MM-DD` section to [CHANGELOG.md](CHANGELOG.md).
2. **Run the release** (this is the only step that touches the remote):

   ```bash
   npm run release -- 1.4.0        # or: DRY_RUN=1 npm run release -- 1.4.0 to preview
   ```

   It bumps `package.json`, commits with the notes, tags `v1.4.0`, pushes the branch and the tag,
   and starts the **Build installer** workflow against the tag.
3. **Check the result** once the build finishes (about two minutes):

   ```bash
   gh run watch <run-id> --repo piterone089-a11y/LinkCharts
   gh api repos/piterone089-a11y/LinkCharts/releases/tags/v1.4.0 \
     --jq '.assets[] | {name, size, digest}'
   ```

   The asset must be `LinkCharts-Setup-1.4.0.exe` and must carry a `sha256:` digest — the app
   refuses to auto-install a release without one.

## Where releases go

- `origin` is `Mehal45/LinkCharts` (read-only for this account). `fork` is
  `piterone089-a11y/LinkCharts`, where releases are published.
- Because it is a fork, a pushed tag does **not** start Actions; `scripts/release.sh` triggers the
  workflow with `gh workflow run … --ref v1.4.0`.
- The app's updater looks at `Mehal45/LinkCharts`, so a fork release is not offered to existing
  installs automatically. To reach them, the change has to land upstream (a PR against `origin`).

## Rolling back

Tags are cheap to delete locally but not on the remote once users have updated:

```bash
git tag -d v1.4.0                       # local
git push fork :refs/tags/v1.4.0         # remote
gh release delete v1.4.0 --repo piterone089-a11y/LinkCharts
```

Never move a published tag — ship a new patch version instead.

## Data files

`data/` (API keys, watchlists) and `.planning/` (local notes) are git-ignored. Keep them that way:
`data/config.json` holds plaintext API secrets.
