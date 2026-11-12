# Orchestration in code, not Flow Designer

The plan called for Flow Designer flows to orchestrate the human steps. We implement orchestration as
code instead: business rules and script actions advance Orders and Order lines, approvals are
`sysapproval_approver` records whose outcome is rolled up by our own rule, and FSM work orders and
change requests are created by gateways. Approvers are dynamic (Customer admins, the Agreement's
account manager), the steps must be unit-testable, and Fluent flows cannot be validated without an
instance. Flows can still be layered on later for notifications or customer-specific extras.

## Considered Options

- Flow Designer flows with `askForApproval` and data-pill approval rules: rejected for the reasons above.
- Catalog item + RITM + flow: replaced by a record producer that creates the Order directly.
