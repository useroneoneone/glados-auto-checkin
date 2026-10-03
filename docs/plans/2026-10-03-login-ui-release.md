# Login UI and deployment release implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the user-verified login UI and a tested, downloadable Linux/amd64 Docker deployment bundle.

**Architecture:** Preserve the native JavaScript frontend and existing authentication endpoints. Audit the upstream React component without changing its repository. Publish the existing GHCR image only after regression tests pass, then attach a version-pinned Compose bundle and SHA-256 checksums to the GitHub Release.

**Tech Stack:** Node.js built-in test runner, Express, Docker, Compose, GitHub Actions, GHCR, Bash.

---

### Task 1: Audit and test the login port

**Files:** `public/animated-login.js`, `public/animated-login.css`, `public/app.js`, `test/animated-login.test.js`, `docs/login-ui-parity.md`.

1. Fetch both repositories and compare the remote React scene at `e812a0fd77fc5389577eea5e945f67b68227b221` with the locally accepted port.
2. Add deterministic fake-DOM/timer tests for per-eye gaze, body skew, 800 ms focus reaction, nonempty password reveal, peeking, and cleanup.
3. Match the React visibility effect: typing more characters while the password remains visible must not restart its peek timer.
4. Run `node --test test/animated-login.test.js` and `npm test`; both must pass. Record intentional branding, theme-storage and reduced-motion differences.

### Task 2: Create a deployable release bundle

**Files:** `scripts/install.sh`, `scripts/package-release.mjs`, `test/release-package.test.js`, `.github/workflows/docker.yml`, `docs/INSTALL.zh-CN.md`, `README.md`, `.gitattributes`.

1. Add bundle tests requiring an explicit image/commit, a version-pinned Compose file, checksums, installer and installation instructions, with no runtime databases or credentials.
2. Create an installer that checks Docker/Compose, preserves existing `.env` and data, generates random secrets only for new installations, asks for a non-default password, and pulls/starts the prebuilt image.
3. Extend the existing workflow to build the bundle and publish GitHub Release assets for `v*` tags only after image tests and publication succeed.
4. Run `npm test`, `bash -n scripts/install.sh`, and locally build/list/checksum the bundle. Verify shell-script LF line endings.

### Task 3: Publish and verify

1. Review the staged file list; exclude `.env`, SQLite files and all runtime data.
2. Commit and push to `main`, and create/push a fresh version tag.
3. Wait for both GitHub Actions runs; check regression-test and image-publication steps, release assets, anonymous GHCR manifest access and image revision.
4. Download the published deployment archive and verify its SHA-256 against the published checksum.
5. Provide the release link and exact server installation/update commands. Do not log in to or restart a remote server in this task.
