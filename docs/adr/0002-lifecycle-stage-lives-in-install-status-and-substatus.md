# Lifecycle stage lives in install status and substatus

An Asset's Lifecycle stage is expressed only through the platform's `install_status` + `substatus`
fields; there is no scoped "stage" field. We add our own `substatus` values (e.g. `staging`,
`pending_in_service`) and every change made by this app goes through one transition function that
checks an allowed-moves matrix. A second state field would drift whenever out-of-box processes
(receiving, asset↔CI sync, transfer orders) change `install_status` directly.

## Consequences

- The SDK refuses `ChoiceSet` on `alm_asset` from a scoped app, so our substatus values are shipped as
  plain `sys_choice` records via `Record()` (dependent on `install_status`).
- A stage set outside the app's moves is checked against the matrix only when a user without `admin`
  saves it in their own transaction: a form edit, and also out-of-box logic that user's action runs.
  The before-update rule on `alm_hardware` refuses such a save, through its Abort action, when the
  matrix does not allow the move or the app does not model the combination. Background processes and
  administrators are not checked, and the app reads whatever stage results. A change into staging
  still clears the wipe evidence, whoever makes it (a before-update rule of its own on
  `alm_hardware`).
- This consequence used to read "changes made outside the app are accepted but not validated", while
  the spec (`docs/spec/p1-fulfilment.md`, Lifecycle stages) and the code refused form edits by users
  without `admin`. The instance accepted them all the same, because the platform ignored the rule's
  `current.setAbortAction` from the app's scope (external-contracts N35). The spec and the code win:
  the rule now refuses through its Abort action, and this ADR follows them.
- Inventory's transfer order logic runs in the transaction of whoever works the line. Closing a task
  of a transfer order line has the out-of-box rule *Push Status to Asset/Consumable* set the Asset
  to
  *In stock / Pending transfer* (Requested, Shipment Preparation) or *In transit / Reserved* (In
  Transit), which the app does not model. The rule saves the Asset without checking the result, and
  the app's `alm_hardware` rules run on that save (external-contracts N38). For an inventory tech
  the save is refused: the line moves on and the Asset keeps its stage (*Staging*, for the transfer
  orders sourcing raises). Whether that calls for a wider exemption is checked on the first install
  (README).
