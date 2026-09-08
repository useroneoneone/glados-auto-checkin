# Check-in overlap repair

## Confirmed Code Issues

- Account-specific locks did not limit simultaneous browsers across accounts.
- Notification waits held browser resources until the full run ended.
- Missing accounts and some initialization failures could leave account locks held.
- Optional points requests could turn a successful check-in into a failed result.
- Manual jobs reported running before actual work and timed out in the UI after five minutes.

## Implementation

Use a single FIFO queue for all manual/scheduled check-ins and login checks.
Deduplicate matching account/action jobs until notification completes. Different
actions for the same account queue normally, so a login check does not discard a
scheduled check-in. Read account settings when execution starts.

Use isolated Playwright API contexts with the existing encrypted cookies. Launch
Chromium only if the check-in endpoint is absent (404/405). Close all contexts
before releasing the queue. Retry only transient read errors, with bounded
attempts/backoff; never automatically replay an uncertain check-in POST.

Persist the check-in result before notification. Deliver notifications through
a separate serial queue with bounded retries and a stable delivery ID/body.
Keep delivery failures separate from check-in status and prevent older delivery
errors from overwriting newer account status.

Expose queued/running/notifying states for scheduled and manual jobs. Webhook
tests also use asynchronous polling, keeping reverse-proxy requests short.

## Verification And Limits

Test overlap, duplicate requests, failure cleanup, login/check-in interactions,
slow/failing notifications, retries, uncertain POSTs, cookie isolation, and
optional points failures using local fixtures only.

Queues remain in memory and support one application process/container. Restart
recovery and durable webhook redelivery are separate future features. Webhook
receivers must honor delivery IDs to guarantee deduplication; robot providers
may show duplicate messages after an ambiguous timeout. Production network
availability is not guaranteed by queueing or retries.
