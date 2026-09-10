## What breaks

A card deposit that Worldpay declines, that times out at the gateway, or that is charged but never reaches the player account all come back as a bare 500. The app cannot tell them apart and shows the same generic error for each.

## What changes

Each of the three cases returns a problem-details response with its own `type` and `reason`, so the app can show the right message.

### BoltBetz.ManagementSystem/Controllers/FinancialController.cs:241

```csharp
internal static ProblemDetailsException WorldpayProblem(string type, string title, int status,
    string detail, string reason, Exception? inner = null)
{
    var details = new ProblemDetails { Type = type, Title = title, Status = status, Detail = detail };
    details.Extensions["reason"] = reason;
    return new ProblemDetailsException(details, inner);
}
```

One helper builds every response so the three cases cannot drift apart.

### BoltBetz.ManagementSystem/Controllers/FinancialController.cs:450

```csharp
throw WorldpayProblem(CardDeclinedProblemType, "Card declined", 402,
    $"The card was declined by the payment gateway. Gateway code: {creditPurchaseOutcome.Failure!.Message}",
    ProblemReason.Declined, creditPurchaseOutcome.Failure);
```

A decline is 402 with reason `declined`. The row is marked rejected and the duplicate guard is cleared so the user can retry at once.

### BoltBetz.ManagementSystem/Controllers/FinancialController.cs:472

```csharp
throw WorldpayProblem(GatewayTimeoutProblemType, "Payment gateway timed out", 504,
    GatewayTimeoutDetail(request.ClientRequestId),
    ProblemReason.InFlight, creditPurchaseOutcome.Failure);
```

A timeout is 504 with reason `in-flight`. The row stays as started, so a resubmit with the same request id lands on the replay path instead of charging twice. A CRITICAL log line is added here so an unknown charge is never silent.

### BoltBetz.ManagementSystem/Controllers/FinancialController.cs:494

```csharp
throw WorldpayProblem(CardChargedNotCreditedProblemType, "Card charged, deposit pending", 409,
    $"Your card was charged but the deposit to your player account could not be completed. " +
    $"Please contact support and reference request {idempotencyId}.",
    ProblemReason.UnderReview);
```

Charged but not credited is 409 with reason `under-review`. It was a 500.

## How to run

```
dotnet test --filter CardDepositProblemDetailsTest
```

## Not run

`dotnet test` was not run on my machine. It needs the test database, which another session held at the time. CI ran it and is green.
