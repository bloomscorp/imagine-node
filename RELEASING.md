# Releasing `@bloomscorp/imagine-node`

## One-time setup (owner)

Do this once, before the first release.

1. **Create the GitHub repository** `bloomscorp/imagine-node` (empty: no README, no
   licence), then push this one:

   ```bash
   git remote add origin https://github.com/bloomscorp/imagine-node.git
   git push -u origin main
   ```

   The name matters: `package.json`'s `repository.url` must be exactly
   `https://github.com/bloomscorp/imagine-node`, or npm rejects the provenance.

2. **Publish the first version by hand.** npm lets you add a trusted publisher only to
   a package that already exists. From a clean checkout of `main`, logged in to npm as
   an owner of the `@bloomscorp` scope:

   ```bash
   npm ci
   npm run lint && npm test && npm run build && npm run verify:package
   npm login
   npm publish --access public
   ```

   This publish has no provenance, which is expected. Then tag it, so the history
   matches what npm serves (the release workflow will run on this tag and fail at the
   publish step, because the version exists; that failure is harmless):

   ```bash
   git tag -a v0.1.0 -m "Release 0.1.0"
   git push origin v0.1.0
   ```

3. **Add the trusted publisher.** On npmjs.com, open the package → **Settings** →
   **Trusted publishing** → **GitHub Actions**, and enter exactly:

   | Field | Value |
   |---|---|
   | Organization or user | `bloomscorp` |
   | Repository | `imagine-node` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave empty)* |

4. **Lock it down** (recommended). In the same settings page, under **Publishing
   access**, choose *Require two-factor authentication and disallow tokens*. Trusted
   publishing keeps working; a leaked token can no longer publish.

There is no `NPM_TOKEN` secret to add to GitHub, now or later.

## Releasing

1. On `main`, up to date, with a clean working tree.
2. Set the new version in `package.json` (and `package-lock.json`):

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

3. Add the version's section to `CHANGELOG.md`.
4. Run the gates locally: `npm run lint && npm test && npm run build && npm run verify:package`.
5. Commit, tag and push:

   ```bash
   git commit -am "chore: release v0.2.0"
   git tag -a v0.2.0 -m "Release 0.2.0"
   git push origin main && git push origin v0.2.0
   ```

Pushing the tag runs **`.github/workflows/release.yml`** on a fresh checkout: it checks
npm is new enough, runs lint, tests, build and the packaging gate, checks the tag equals
`package.json`'s version, runs `npm publish --provenance --access public`, and creates
the GitHub release.

A prerelease version (`1.0.0-rc.1`) is published under the `next` dist-tag, never
`latest`, and its GitHub release is marked as a prerelease.

### What gets published

Only `dist/` (CJS, ESM and both `.d.ts` files), `README.md`, `LICENSE.md` and
`package.json`. `npm run verify:package` fails on anything else (sources, tests,
`examples/`), on a missing file, on a runtime dependency, on a wrong `repository.url`,
and if either build fails to load, reports the wrong `VERSION`, or signs the shared
webhook vector differently.

## Afterwards

```bash
npm view @bloomscorp/imagine-node version
```

`ETARGET` from `npm install` straight after a publish is the npm CDN catching up. Wait
a few minutes before concluding anything.

## If something goes wrong

**`E404 … could not be found or you do not have permission` at the publish step.** The
trusted publisher does not match this repository and workflow exactly (`release.yaml`
for `release.yml` is enough to break it). npm doesn't allow editing it: delete the entry,
create it again, then **Re-run failed jobs** on the same run. Nothing was published, so
no new tag is needed.

**`EOTP` or `ENEEDAUTH`.** npm did not see the publish as a trusted one: the trusted
publisher is missing, or the workflow lost `id-token: write`.

**The tag does not match `package.json`.** The workflow stops before publishing. Fix the
version, then move the tag:

```bash
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
# commit the fix, then:
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin main && git push origin vX.Y.Z
```

**It published, but the version is wrong.** npm versions are immutable. Release the next
patch; never try to replace a published version.

## Versioning

Semantic versioning. While the version is `0.x`, a minor release may change the API;
the change goes in `CHANGELOG.md` under the version.

The webhook vectors in `test/vectors/webhook-signature.json` are shared with
`imagine-java`. Change them only in both repositories together.
