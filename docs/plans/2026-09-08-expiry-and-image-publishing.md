# Cookie expiry warnings and prebuilt images

## Cookie Warnings

Each account has a warning toggle (default on) and a lead time of 1-30 days
(default 3). Only enabled accounts with a known expiry and configured webhook
qualify. The scanner runs at startup and once per minute independently of the
GLaDOS task queue.

Before expiry, send at most one successful warning per account-local calendar
day. After expiry, send one successful expired notice per expiry value.
Persist attempts and outcomes in SQLite with unique account/expiry/phase/period
keys. Retry failures no more often than hourly, retaining the delivery ID.
Recheck eligibility immediately before webhook requests. Old alerts are canceled
when the account is disabled, removed, or its Cookie/target configuration changes.

Warnings do not change check-in status/history. Display warning settings and the
last delivery state in the account view.

## Container Publishing

GitHub Actions builds a linux/amd64 image on main, version tags, or manual
dispatch; pull requests run verification only. Pin third-party actions to
verified commit SHAs. Run unit/integration and browser smoke tests inside the
built image before using GITHUB_TOKEN to publish that exact image to GHCR.

Publish immutable sha tags and update latest only from main. Use OCI source
labels to link the package to the repository. Keep local source-build Compose
unchanged and add a production image-only Compose file with the same service,
container name, data bind mount, and fixed internal port/database path.

Document first-time package visibility setup, minimal deployment, updates,
existing-install migration, and rollback. Preserve existing .env secrets and
database files when updating servers. Never bake running data or credentials
into images.
