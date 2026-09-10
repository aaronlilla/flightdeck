NewCreditCardDeposit answered a Worldpay decline, a gateway timeout, or a charged-but-not-credited CWA deposit with a bare 500, so the client's error-contract seam had nothing to read. This maps all three to problem-details.

Changed in `FinancialController.cs`:
- New const block and `WorldpayProblem` helper (lines 36-63)
- The Worldpay call and its catch block, now split on `WorldpayException.StatusCode == 0` (our own decline signal) vs. everything else (lines 939-1006)
- The final `UnderReview` check, now 409 instead of 500 (lines 1148-1154)

Three `type` values for the app to match: `card-declined` (402, reason `declined`), `gateway-timeout` (504, reason `in-flight`, echoes the ClientRequestId), `card-charged-not-credited` (409, reason `under-review`, was the F-39 500). The existing CRITICAL log lines are untouched; the timeout branch adds its own so an unknown-outcome charge isn't silent.

Tests: `CardDepositProblemDetailsTest.cs`, one per case, asserting status/type/reason on `WorldpayProblem`'s output. Not run locally — `dotnet test` needs the `bbms-test-db` lock, held by another live session. CI is the referee.

This is a backend-only change with no screen to look at; the ticket's RN-flavored Haiping handoff schema (android/ios fingerprints) doesn't apply here, so I'm leaving it out rather than inventing values.

Controlled repo — assigning Joe to review.
