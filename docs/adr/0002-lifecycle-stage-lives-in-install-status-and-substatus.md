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
- The app's rules on `alm_hardware` act on Fleet assets only (ADR 0016): the Provider IT's equipment
  shares the table, and its stages are neither checked nor changed.
- Transfer orders are modelled (owner decision, 2026-11-09). Inventory's transfer order logic runs in
  the transaction of whoever works the line, and its before rule *Push Status to Asset/Consumable* on
  `alm_transfer_order_line` saves the line's Asset through `alm_asset` without checking the result
  (external-contracts N38): *In stock / Pending transfer* at Draft, Requested and Shipment Preparation,
  *In transit / Reserved* at In Transit, each with the Asset's *Active transfer order* flag
  (`active_to`) set, and *In stock / Available* in the to-stockroom at Received, with the flag
  cleared (*In stock / Reserved* for a line requested for a user). *Release Asset on TOL
  cancel/delete* saves *In stock / Available* where the Asset was and clears the flag too
  (external-contracts N39). The app's `alm_hardware` rules run on those saves.
  - Both transfer combinations are one stage, *In transfer*: the one stage stored as two combinations
    (`domain/lifecycle.ts`). An Asset enters it from available, reserved, spare pool or staging and
    leaves it back to one of those. It may enter only while the flag is set, and leave only once it
    is cleared, so a form edit by a user without `admin` can neither put an Asset in transfer nor
    free a unit still on its way between two stockrooms. The flag, not a query of the lines, is the
    fact checked: on a line's insert the Asset is saved before the line is written. *Cancel order*
    takes a unit in transfer off its Order line and leaves it in transfer, so it is free stock once
    Inventory lets it go: freed earlier, it would read as stock in the stockroom it left, which
    sourcing could claim and Inventory would not take onto another line (*Validate TOL and check
    availibility* refuses an Asset whose flag is set).
  - When Inventory lets an Asset go (the flag cleared, the Asset saved *In stock*), a before rule
    ahead of the lifecycle rule gives it back the stage it left instead, in the same save and in the
    stockroom Inventory set (`domain/lifecycle.ts` `stageAfterTransfer`). The stage is read from what
    the Asset still carries and where Inventory left it, as the app records no stage of its own: on
    an Order line, staging once at the staging centre with its Staging task open, and reserved
    otherwise; held for a Customer, its Spare pool; otherwise available, as Inventory left it.
  - Only sourcing transfers a unit on an Order line, and only to the staging centre. One that
    Inventory lets go anywhere else (its line cancelled or deleted) is reserved again where it was,
    where nothing moves it on: its transfer has fallen through (`transferFellThrough`). The after rule
    on its stage change puts it back as free stock, skips its Staging task and sources its Order again
    (`entry/orders.ts` `putBackUntransferred`). Sourcing itself removes the lines of a transfer order
    it could not complete; it marks those units for the transaction, as reads past the visibility
    rules mark their record (ADR 0005, external-contracts N37), so their release is not taken for a
    transfer fallen through, and puts them back itself.
  - Inventory takes a unit onto a line only from *In stock / Available*: its rule *Validate TOL and
    check availibility* refuses the substatuses of reserved, spare-pool and staging stock. So sourcing
    hands a unit it reserved over there, still on its Order line and so claimed by nobody else, just
    before it inserts the unit's line; Inventory then puts it in transfer. Its Staging task opens at
    once, and the unit goes into staging when the line is received at the staging centre.
- This consequence used to say that the lifecycle rule refused, for an inventory tech, the Asset saves
  Inventory's transfer order logic makes, leaving the Asset in *Staging* while the line moved on, and
  left it to the first install whether that called for a wider exemption. Read on the instance,
  Inventory would not have taken those units onto a line at all, as sourcing had reserved them first,
  and a received line would have saved its Asset available in the staging centre, still on its Order
  line. Modelling the transfer replaces that.
