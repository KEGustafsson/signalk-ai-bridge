# Development


For local development:

```bash
npm install
npm run dev
```

To render the panel against the real plugin routes without a Signal K server,
run the preview host and the dev server in **two separate shells** (the preview
host keeps running). `--stub` also stubs the inference backend, so no model is
needed.

First shell:

```bash
node scripts/preview-host.mjs --stub
```

Second shell:

```bash
SIGNALK_AI_BRIDGE_DEV_TARGET=http://127.0.0.1:3100 npm run dev
```

Useful checks:

```bash
npm run test
npm run check
```

To remove generated build output:

```bash
npm run clean
```

To build the packaged web UI:

```bash
npm run build
```

## Continuous Integration

Two workflows run on every push and pull request:

- **`signalk-plugin-ci`** calls the canonical
  [`SignalK/signalk-server` reusable plugin CI workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml).
  It validates the plugin the way the Signal K server and App Store actually
  load it — package metadata, entry point, `schema()`, the start/stop/restart
  lifecycle, deprecated and internal API usage, `npm pack` contents and an
  `--ignore-scripts` App Store install — across Linux x64/arm64, macOS and
  Windows on Node 22 and 24, plus a live `signalk-server` install. It runs on
  every pushed branch and tag as well as on pull requests, so whichever commit
  a release is published from has a run for the registry to find.
- **`ci`** runs the repository's own smoke test, type check, unit tests and a
  production `npm audit`, and then packs the plugin, installs the tarball with
  production dependencies only and runs the suite again from there — which is
  how the plugin registry runs it.

The build and test commands declared to the reusable workflow are also what the
[Signal K plugin registry](https://signalk.org/signalk-plugin-registry/) reads
when it scores the plugin, so they are asserted by `npm run lint`.

### Publishing

The registry scores the **published package**, not this repository, so two
things about a release matter beyond the code in it:

- **Publish from a git checkout of `main`.** `npm publish` records the commit
  it published from as `gitHead`, and the registry needs that together with the
  `repository` field to find this plugin's `signalk-plugin-ci` run for the
  release. Publishing from an unpacked tarball or a tree without `.git` leaves
  `gitHead` unset, and the score takes a 10-point `no-plugin-ci` penalty for a
  workflow that did in fact run.
- **Make the release `latest`.** The registry scores only the version npm's
  `latest` dist-tag points at, so a release meant to be scored is published
  without `--tag next` (or moved to `latest` with `npm dist-tag add`).
- **Keep the suite in the tarball.** The registry runs `npm test` inside the
  installed plugin. `npm run lint` asserts that everything it reads —
  `scripts/run-tests.mjs`, `test/`, `src/` and the two `tsconfig` files — is
  covered by `files` in `package.json`, and the `packaged-tests` CI job proves
  the suite still passes there with devDependencies absent.

`npm pack --dry-run` shows exactly what a release will contain.

## Testing on a Jetson

Installing a pre-release build on a Jetson, and what to check once it runs, is in
[GPU, Jetson and choosing a model](jetson.md#testing-on-a-jetson-before-a-release).
