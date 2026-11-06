# Lifecycle stage lives in install status and substatus

An Asset's Lifecycle stage is expressed only through the platform's `install_status` + `substatus`
fields; there is no scoped "stage" field. We add our own `substatus` values (e.g. `staging`,
`pending_in_service`) and every change made by this app goes through one transition function that
checks an allowed-moves matrix. A second state field would drift whenever out-of-box processes
(receiving, asset↔CI sync, transfer orders) change `install_status` directly.

## Consequences

- The SDK refuses `ChoiceSet` on `alm_asset` from a scoped app, so our substatus values are shipped as
  plain `sys_choice` records via `Record()` (dependent on `install_status`).
- Changes made outside the app are accepted but not validated; the app reads whatever stage results.
