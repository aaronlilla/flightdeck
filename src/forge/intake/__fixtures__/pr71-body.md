ACH and FedNow webhooks now reconcile the way RTP does, a stranded webhook is loud enough to alarm on, and the idempotency story is proven rather than assumed. BBZ-73, BBZ-75, BBZ-77.

## What Sila says, what the CWA does, what the row becomes

| Sila said | What the CWA does | What the row becomes |
|---|---|---|
| `RTP` / `FEDNOW` issue, success | deposit `TransactionAmount` | `Completed`; `Cancelled` if the CWA deposit throws and the Sila refund succeeds |
| `RTP` / `FEDNOW` issue, failed | nothing | `RejectedByPaymentProcessor` |
| `RTP` / `FEDNOW` redeem, success | nothing | `Completed` |
| `RTP` / `FEDNOW` redeem, failed | re-deposit `TransactionAmount` | `RejectedByPaymentProcessor`; `UnderReview` + CRITICAL if it throws |
| `STANDARD_ACH` / `SAME_DAY_ACH` issue, success | nothing, the credit ran in the request | `Completed`, `ProcessedDate` stamped |
| `STANDARD_ACH` / `SAME_DAY_ACH` issue, failed | nothing, no cached PIN to debit with | `UnderReview`, CRITICAL `event=sila_webhook_credit_stranded` |
| `STANDARD_ACH` / `SAME_DAY_ACH` redeem, success | nothing | `Completed`, `ProcessedDate` stamped |
| `STANDARD_ACH` / `SAME_DAY_ACH` redeem, failed | re-deposit via the cached PIN | `RejectedByPaymentProcessor`; `UnderReview` + CRITICAL if the PIN expired |
| any rail, `review` | nothing | `UnderReview` |
| unrecognised rail, failed withdrawal | nothing | `UnderReview`, CRITICAL `event=sila_webhook_failed_withdrawal` |
| unrecognised rail, anything else | nothing | untouched, Warning with the literal type |
| anything, row still `InitiatedByUser` | waits for the originating request to land, then settles normally | `UnderReview` + CRITICAL only if the request never lands |

Both rails take the row with one conditional UPDATE before any Synkros call, so only one delivery can act on it. Duplicate delivery of an already-resolved transfer is a no-op at the same claim. A redelivered event whose prior attempt never finished routes through `SilaWebhookPlan.ForRedelivery` for its level and marker, the same helper both duplicate-key branches call, instead of the controller writing that decision inline twice.

## Known, not fixed here

`FinancialTransaction` carries no concurrency token, so `FinancialController.cs:723` can still overwrite a status the webhook wrote while the originating request is in flight. The wait above narrows that window but doesn't close it. Closing it needs a rowversion on the entity, which ships in the `BoltBetz.Database` package, outside this branch's territory. Also pre-existing and unchanged: the Synkros call and the local status write aren't one transaction, `Completed` names both the resting state and a success outcome, and no test instantiates the controller directly, so coverage below is on the pure helpers and the claim, not the endpoint.

## Coverage

268 of 268 with a real SQL Server, all five `[RequiresBoltBetzDatabase]` classes included, nothing skipped.

Head: `b7bd197e4a4c846dfcb306092fe892e31a27df77`. Staying draft until the repo's audit queue posts a verdict against this head.

