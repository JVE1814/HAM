# Plan 013: Keep failed warehouse scans on screen until the operator rescans or dismisses them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1864b17..HEAD -- src/client/warehouse`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-lint-tracked-sources.md
- **Category**: bug
- **Planned at**: commit `1864b17`, 2026-11-12

## Why this matters

The warehouse page (`/warehouse.html`) sends each scan to the server from a queue and writes one line per scan into a single log that keeps the newest 50 lines. A failed scan is only a red line in that log. The queue drops it and moves on, and 50 later scans push it off the screen. Nothing then says that a unit was not received, not picked or not counted. An expired session makes every later scan fail the same way. The server also answers some scans with HTTP 503 and the words "scan again" (for example *Another scan is receiving this unit: scan again*), so the operator needs the failed code at hand.

After this plan, failed scans sit in their own list that is never cut short, with a count. Each has a **Rescan** button that queues the same scan again with the context it was scanned in, and a **Dismiss** button. Nothing is retried automatically: the server may have applied a scan whose reply was lost, so a person decides.

## Current state

Files:

- `src/client/warehouse/station.tsx` (153 lines). `StationProvider` holds the scanning state that outlives a mode switch: context fields, the scan queue, the log, the labels. Contains the log state and the failure handling.
- `src/client/warehouse/scan-queue.ts` (33 lines). The queue. It calls `run` for one scan at a time and goes on when `run` throws. Not changed by this plan.
- `src/client/warehouse/scan-queue.test.ts`. The test style to copy.
- `src/client/warehouse/ModeScreen.tsx` (117 lines). Renders the context fields, the scan field, the log (`ScanLog`) and the labels.

`src/client/warehouse/station.tsx:35-46`:

```tsx
type Context = Record<ContextField, string>

interface Scan extends Context {
    mode: Mode
    code: string
}

export interface Entry {
    id: number
    ok: boolean
    message: string
}
```

`src/client/warehouse/station.tsx:50-59`:

```tsx
interface Station {
    stockrooms: Stockroom[]
    context: Context
    setContext: (field: ContextField, value: string) => void
    scan: (mode: Mode, code: string) => void
    pending: number
    log: readonly Entry[]
    labels: readonly AssetSummary[]
    clearLabels: () => void
}
```

`src/client/warehouse/station.tsx:74` and `:85-98`:

```tsx
    const [log, setLog] = useState<Entry[]>([])
```

```tsx
    // One queue for the page's life: each scan carries its own context, and the queue only sets state.
    const [queue] = useState(() => {
        let next = 0
        const record = (ok: boolean, message: string) => setLog((l) => [{ id: next++, ok, message }, ...l].slice(0, 50))
        return scanQueue<Scan>(async (scan) => {
            try {
                const scanned = await perform(scan)
                record(true, describe(scanned))
                if (scanned.mode === 'receive' && scanned.asset.providerTag) setLabels((current) => [scanned.asset, ...current])
            } catch (error) {
                record(false, `${scan.code}: ${(error as Error).message}`)
            }
        }, setPending)
    })
```

`src/client/warehouse/ModeScreen.tsx:81`:

```tsx
            <ScanLog entries={station.log} />
```

`src/client/warehouse/ModeScreen.tsx:105-117`:

```tsx
/** Newest first. Each entry is one line of the server's words, so a list of alerts reads better than a grid of one column. */
function ScanLog({ entries }: { entries: readonly Entry[] }) {
    return (
        <div role="log" aria-live="polite" className="flex flex-col gap-1.5 print:hidden">
            {entries.map((entry) => (
                <Alert key={entry.id} role={undefined} variant={entry.ok ? 'default' : 'destructive'}>
                    {entry.ok ? <CircleCheckIcon /> : <CircleXIcon />}
                    <AlertTitle className="font-normal">{entry.message}</AlertTitle>
                </Alert>
            ))}
        </div>
    )
}
```

Constraints that shape the design:

- Client tests run under vitest in the `node` environment (`vitest.config.ts`: `include: ['src/server/**/*.test.ts', 'src/client/**/*.test.ts']`, `environment: 'node'`). There is no jsdom and no component-test library. Do not add one.
- A client test can import only `.ts` modules that use relative imports. `vitest.config.ts` defines no `@/` alias, and `tsconfig.test.json` (which typechecks `src/client/**/*.test.ts`) has no `jsx` option and no `paths`. A test that imports a `.tsx` file, or a `.ts` file that imports one, fails typecheck. So the new logic goes in a new pure `.ts` file, and that file must not import from `station.tsx`.
- UI components are the shadcn ones under `src/client/components/ui/`. `alert.tsx` exports `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction`. `badge.tsx` exports `Badge` with a `destructive` variant. `button.tsx` exports `Button` with `variant="outline"` and `size="sm"` (both already used in `src/client/customer/equipment.tsx:174`).
- Comments: only for a non-obvious why. Match the doc-comment style of the files above.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 (needs plan 001; before it, use `npx eslint src`) |
| The new tests | `npx vitest run src/client/warehouse` | all pass |
| Build | `npm run build` | exit 0 |
| Full gate | `npm run check` | exit 0, all tests pass |

`npm run build` rewrites the tracked file `src/fluent/generated/keys.ts`. If `git status` shows it changed after a build, commit it with your change.

## Scope

**In scope** (the only files you should modify):

- `src/client/warehouse/scan-log.ts` (create)
- `src/client/warehouse/scan-log.test.ts` (create)
- `src/client/warehouse/station.tsx`
- `src/client/warehouse/ModeScreen.tsx`
- `src/fluent/generated/keys.ts` (only if the build rewrites it)

**Out of scope** (do NOT touch):

- `src/client/warehouse/scan-queue.ts` and its test. The queue stays as it is: it never retries and never keeps a failed scan.
- Any automatic retry of a failed scan. A POST whose reply was lost may have been applied.
- `src/client/warehouse/ScanField.tsx`, `routes.tsx`, `api.ts`.
- `perform` and `describe` in `station.tsx`. Plan 018 moves and tests them. Leave them where they are.
- Anything under `src/server`.

## Git workflow

- Branch: `advisor/013-failed-scans-visible`
- One commit is enough. Subject: an imperative sentence under 72 characters in the repo's style, for example `Keep a failed scan on the warehouse page until it is dismissed`. Other subjects in `git log`: `Refuse a server module that is not a .ts file`. The body says what was wrong and why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the scan log as a pure reducer

Create `src/client/warehouse/scan-log.ts` with exactly this shape. It is generic over the scan type `T`, so it imports nothing from `station.tsx`.

```ts
/** One sent scan as the log shows it: the server's words. */
export interface Entry {
    id: number
    message: string
}

/** A scan that failed, kept with the context it was scanned in so it can be sent again as it was. */
export interface FailedScan<T> {
    id: number
    scan: T
    message: string
}

/**
 * What the page shows of the scans sent. `sent` is the newest scans that went through, cut at RECENT. `failed` is
 * never cut: a failed scan is a unit not received, picked or counted, and stays until the operator rescans or
 * dismisses it.
 */
export interface ScanLog<T> {
    next: number
    sent: readonly Entry[]
    failed: readonly FailedScan<T>[]
}

export type ScanLogAction<T> =
    | { type: 'sent'; message: string }
    | { type: 'failed'; scan: T; message: string }
    | { type: 'dismissed'; id: number }
    | { type: 'dismissedAll' }

export const RECENT = 50

export const EMPTY_LOG: ScanLog<never> = { next: 0, sent: [], failed: [] }

export function scanLog<T>(log: ScanLog<T>, action: ScanLogAction<T>): ScanLog<T> {
    switch (action.type) {
        case 'sent':
            return { ...log, next: log.next + 1, sent: [{ id: log.next, message: action.message }, ...log.sent].slice(0, RECENT) }
        case 'failed':
            return { ...log, next: log.next + 1, failed: [{ id: log.next, scan: action.scan, message: action.message }, ...log.failed] }
        case 'dismissed':
            return { ...log, failed: log.failed.filter((failure) => failure.id !== action.id) }
        case 'dismissedAll':
            return { ...log, failed: [] }
    }
}
```

Notes:

- Both lists are newest first.
- A rescan is `dismissed` followed by queuing the scan again. Its outcome arrives later as a new `sent` or `failed` action with a new id. The reducer has no `rescan` action.
- `next` is never reset, so an id is never reused as a React key.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Test the reducer

Create `src/client/warehouse/scan-log.test.ts`. Model it on `src/client/warehouse/scan-queue.test.ts` (plain `describe`/`it`/`expect` from `vitest`, a relative import of the module). Use a small scan type such as `{ code: string; order: string }`. Start each test from `EMPTY_LOG`. Cases:

1. `shows the newest sent scan first and keeps only the newest 50`: apply 51 `sent` actions with messages `m0` to `m50`. Expect `sent.length` to be `RECENT`, `sent[0].message` to be `m50`, and no entry with message `m0`.
2. `keeps every failed scan, however many scans follow it`: apply one `failed` action for `{ code: 'BAD', order: 'NORD1' }` with message `BAD: refused`, then 60 `sent` actions. Expect `failed` to equal `[{ id: 0, scan: { code: 'BAD', order: 'NORD1' }, message: 'BAD: refused' }]`.
3. `keeps more than 50 failed scans, newest first`: apply 60 `failed` actions. Expect `failed.length` to be 60 and `failed[0].scan` to be the last one applied.
4. `keeps the context a failed scan was scanned in`: the `scan` object in `failed[0]` is the same object that was passed in (`toBe`).
5. `dismisses one failed scan by id and leaves the others`: two failures, dismiss the first one's id, expect only the second left. Dismissing an id that is not there returns equal lists.
6. `dismisses all failed scans and keeps the sent ones`.
7. `never reuses an id`: apply `sent`, `failed`, `dismissed` (id 1), `failed`. Collect every id in `sent` and `failed`; expect the new failure's id to be `2`.

**Verify**: `npx vitest run src/client/warehouse/scan-log.test.ts` → 7 tests pass.

### Step 3: Use the reducer in `StationProvider`

Edit `src/client/warehouse/station.tsx`:

1. Delete the `Entry` interface (lines 42-46). Import from the new module instead: `import { EMPTY_LOG, scanLog, type Entry, type FailedScan, type ScanLog, type ScanLogAction } from './scan-log'`.
2. Export the `Scan` interface (add `export` to `interface Scan`). `ModeScreen.tsx` needs it to name a failed scan's mode.
3. In `interface Station`, keep `log: readonly Entry[]` and add:

    ```tsx
    failed: readonly FailedScan<Scan>[]
    /** Sends a failed scan again as it was scanned. Never done for the operator: the server may have applied the first try. */
    rescan: (failure: FailedScan<Scan>) => void
    dismiss: (id: number) => void
    dismissAll: () => void
    ```

4. Replace `const [log, setLog] = useState<Entry[]>([])` with a reducer. Add `useReducer` to the `react` import.

    ```tsx
    const [log, record] = useReducer(scanLog<Scan>, EMPTY_LOG as ScanLog<Scan>)
    ```

    If TypeScript refuses the instantiation expression `scanLog<Scan>`, write `(state: ScanLog<Scan>, action: ScanLogAction<Scan>) => scanLog(state, action)` instead.

5. Replace the queue's body. The `let next` counter and the `record` closure go away; the reducer owns the ids.

    ```tsx
    const [queue] = useState(() =>
        scanQueue<Scan>(async (scan) => {
            try {
                const scanned = await perform(scan)
                record({ type: 'sent', message: describe(scanned) })
                if (scanned.mode === 'receive' && scanned.asset.providerTag) setLabels((current) => [scanned.asset, ...current])
            } catch (error) {
                record({ type: 'failed', scan, message: `${scan.code}: ${(error as Error).message}` })
            }
        }, setPending),
    )
    ```

    Keep the existing comment above it (`// One queue for the page's life: ...`). `record` is the reducer's dispatch, which React keeps stable, so capturing it once is correct.

6. In the `station` object, replace `log,` with:

    ```tsx
    log: log.sent,
    failed: log.failed,
    rescan: (failure) => {
        record({ type: 'dismissed', id: failure.id })
        queue(failure.scan)
    },
    dismiss: (id) => record({ type: 'dismissed', id }),
    dismissAll: () => record({ type: 'dismissedAll' }),
    ```

    `queue(failure.scan)` sends the stored scan unchanged: its mode, stockroom, order number, audit number and PID are the ones captured when it was first scanned, not the fields on screen now.

7. Update the doc comment on `StationProvider` to name the failed scans: `/** The scanning state that outlives a mode switch: the context fields, the scan queue, its log, the failed scans and the labels. */`

Remove any import that is now unused (`ScanLogAction` if you did not need it).

**Verify**: `npm run typecheck` → it fails only in `ModeScreen.tsx` if at all (the `Entry` import and `entry.ok`). Step 4 fixes that. `npx eslint src/client/warehouse/station.tsx` → exit 0.

### Step 4: Show the failed scans above the log

Edit `src/client/warehouse/ModeScreen.tsx`:

1. Imports: `Entry` now comes from `./scan-log`, with `FailedScan`. Import `MODES` and `type Scan` from `./station`. Add `AlertAction` to the alert import, and import `Badge` from `@/components/ui/badge`. `CircleXIcon` is still used; `CircleCheckIcon` is still used.
2. Between `<ScanField ... />` and `<ScanLog ... />` render the failed scans, only when there are any:

    ```tsx
    {station.failed.length > 0 && (
        <FailedScans failed={station.failed} onRescan={station.rescan} onDismiss={station.dismiss} onDismissAll={station.dismissAll} afterAction={focusScan} />
    )}
    ```

3. Add the component under `ModeScreen`:

    ```tsx
    /** Scans the server refused or never answered. They stay until rescanned or dismissed: each is a unit not received, picked or counted. */
    function FailedScans({
        failed,
        onRescan,
        onDismiss,
        onDismissAll,
        afterAction,
    }: {
        failed: readonly FailedScan<Scan>[]
        onRescan: (failure: FailedScan<Scan>) => void
        onDismiss: (id: number) => void
        onDismissAll: () => void
        afterAction: () => void
    }) {
        const act = (action: () => void) => () => {
            action()
            // A removed button drops focus to the page; the next scan must land in the scan field.
            afterAction()
        }
        return (
            <section aria-label="Failed scans" className="flex flex-col gap-1.5 print:hidden">
                <div className="flex items-center gap-2">
                    <h2 className="text-sm font-medium">Failed scans</h2>
                    <Badge variant="destructive">{failed.length}</Badge>
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={act(onDismissAll)}>
                        Dismiss all
                    </Button>
                </div>
                {failed.map((failure) => (
                    <Alert key={failure.id} variant="destructive" className="has-data-[slot=alert-action]:pr-44">
                        <CircleXIcon />
                        <AlertTitle className="font-normal">
                            {MODES.find((mode) => mode.id === failure.scan.mode)?.title}: {failure.message}
                        </AlertTitle>
                        <AlertAction className="flex gap-1">
                            <Button variant="outline" size="sm" onClick={act(() => onRescan(failure))}>
                                Rescan
                            </Button>
                            <Button variant="ghost" size="sm" onClick={act(() => onDismiss(failure.id))}>
                                Dismiss
                            </Button>
                        </AlertAction>
                    </Alert>
                ))}
            </section>
        )
    }
    ```

    The `pr-44` class makes room for two buttons: `Alert` reserves `pr-18` for one action by default. If the buttons overlap the text in the dev-server check, adjust that one class.

4. `ScanLog` now shows only scans that went through. Remove the `entry.ok` branches:

    ```tsx
    /** Newest first, the scans that went through. Each entry is one line of the server's words, so a list of alerts reads better than a grid of one column. */
    function ScanLog({ entries }: { entries: readonly Entry[] }) {
        return (
            <div role="log" aria-live="polite" className="flex flex-col gap-1.5 print:hidden">
                {entries.map((entry) => (
                    <Alert key={entry.id} role={undefined}>
                        <CircleCheckIcon />
                        <AlertTitle className="font-normal">{entry.message}</AlertTitle>
                    </Alert>
                ))}
            </div>
        )
    }
    ```

5. Update the doc comment on `ModeScreen` to: `/** One mode's screen: its context fields, the scan field, the failed scans, the scan log and the labels to print. Only the labels print. */`

Each failed `Alert` keeps its default `role="alert"`, so a screen reader announces a failure when it appears.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

### Step 5: Run the gate

**Verify**: `npm run check` → exit 0, all tests pass (1586 at the planned-at commit plus your 7, plus whatever earlier plans added).

### Step 6 (needs an instance; optional): Look at it in a browser

`npm run dev` serves the pages from source and proxies the instance's APIs with the SDK's stored credential. It only works when the machine has a ServiceNow instance configured for `now-sdk`. If you have none, skip this step and say so in your report. The done criteria below do not need it.

With an instance: run `npm run dev`, open `/warehouse.html` at the URL it logs, choose **Look up**, and scan the code `NO-SUCH-UNIT-1`. Expected: a "Failed scans" section with count 1 and a line starting `Look up: NO-SUCH-UNIT-1:`. Press **Rescan**: the line goes and comes back (the server refuses again) and focus is in the scan field. Press **Dismiss**: the section disappears. Switch to another mode tab with a failure on screen: the failure is still listed.

## Test plan

- New file `src/client/warehouse/scan-log.test.ts`, 7 cases listed in step 2. They cover the regression (a failure survives any number of later scans), the untruncated list, the captured context, dismissal and id uniqueness.
- Pattern: `src/client/warehouse/scan-queue.test.ts`.
- The wiring in `station.tsx` and the markup in `ModeScreen.tsx` have no automated test: the repo has no DOM test stack. Typecheck covers their shapes. Step 6 covers their behaviour when an instance is available.
- Verification: `npx vitest run src/client/warehouse` → all pass, including the 7 new tests and the existing `scan-queue` and `code128` tests.

## Done criteria

ALL must hold. All are local; none needs an instance.

- [ ] `npm run check` exits 0
- [ ] `npx vitest run src/client/warehouse/scan-log.test.ts` passes 7 tests
- [ ] `grep -n "slice(0, 50)" src/client/warehouse/station.tsx` returns no matches
- [ ] `grep -n "entry.ok" src/client/warehouse/ModeScreen.tsx` returns no matches
- [ ] `git diff --stat 1864b17..HEAD -- src/client/warehouse/scan-queue.ts` is empty
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated
- [ ] Your report says whether step 6 was run or skipped

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- A step's verification fails twice after a reasonable fix attempt.
- Making the tests pass seems to need jsdom, `@testing-library`, a vitest alias, or a change to `vitest.config.ts` or any `tsconfig`. The design avoids all of them; needing one means something went wrong.
- You find yourself changing `scan-queue.ts` or adding a retry.
- `scan-log.ts` needs an import from `station.tsx` to compile.

## Maintenance notes

- Plan 018 (`plans/018-client-logic-tests.md`) moves `perform`, `describe`, the mode table and the `Scan` type out of `station.tsx` into a pure module and tests them. It expects `Scan` to be exported from `station.tsx` and `scan-log.ts` to stay generic.
- The page warns before unload only while scans are pending (`station.tsx`, the `beforeunload` effect). Leaving with failed scans on screen loses them without a warning. That was left out on purpose: a failed Look up is not lost work, and a warning on every such page leave would train operators to ignore it. Revisit if operators report lost failures.
- A rescan sends the stored scan, including a PID captured at the first scan. A reviewer should check that `rescan` passes `failure.scan` untouched and that nothing calls `queue` from the catch block.
- The failed list is in memory only. A page reload clears it. Persisting it (for example in `sessionStorage`) is a possible follow-up; it needs a decision on stale context after a reload.
