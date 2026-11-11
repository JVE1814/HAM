import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useAppForm } from '@/components/form'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import type { Attestation, AttestationItem, AttestationReceipt } from '../../server/domain/rest-contracts'
import { ATTESTATION_RESPONSE_CHOICES, type AttestationResponse } from '../../server/domain/vocabulary'
import { customerApi, overviewKey, overviewQuery } from './api'
import { useBusy } from './busy'

const ANSWERS = (Object.keys(ATTESTATION_RESPONSE_CHOICES) as AttestationResponse[]).map((response) => ({
    value: response,
    label: ATTESTATION_RESPONSE_CHOICES[response].label,
}))

export function Attestations() {
    const { data: overview } = useSuspenseQuery(overviewQuery)
    if (overview.attestations.length === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyTitle>Nothing to confirm right now.</EmptyTitle>
                </EmptyHeader>
            </Empty>
        )
    }
    return overview.attestations.map((attestation) => <AttestationForm key={attestation.id} attestation={attestation} />)
}

function AttestationForm({ attestation }: { attestation: Attestation }) {
    const busy = useBusy()
    const answer = useMutation({
        mutationFn: (items: AttestationItem[]) =>
            customerApi.answerAttestation(
                attestation.id,
                items.map(({ id, response }) => ({ id, response })),
                true,
            ),
        meta: { done: (r: AttestationReceipt) => `${r.attestation} submitted, thank you`, refresh: [overviewKey] },
    })
    const form = useAppForm({
        defaultValues: { answers: attestation.items.map((item): string => item.response) },
        onSubmit: async ({ value }) => {
            const items = attestation.items.map((item, i) => ({ ...item, response: value.answers[i] as AttestationResponse }))
            // The MutationCache toasts a failure; the answers stay as given.
            await answer.mutateAsync(items).catch(() => undefined)
        },
    })
    return (
        <Card>
            <form
                className="contents"
                onSubmit={(event) => {
                    event.preventDefault()
                    void form.handleSubmit()
                }}
            >
                <CardHeader>
                    <CardTitle>
                        {attestation.number}: {attestation.site}
                    </CardTitle>
                    <CardDescription>Is each of these devices at the site?</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                    {attestation.items.map((item, i) => (
                        <form.AppField key={item.id} name={`answers[${i}]`}>
                            {(field) => <field.RadioField label={`${item.model} · ${item.serial}`} options={ANSWERS} />}
                        </form.AppField>
                    ))}
                </CardContent>
                <CardFooter>
                    <form.Subscribe selector={(state) => state.values.answers.every(Boolean)}>
                        {(complete) => (
                            <form.AppForm>
                                <form.SubmitButton disabled={busy || !complete}>Submit</form.SubmitButton>
                            </form.AppForm>
                        )}
                    </form.Subscribe>
                </CardFooter>
            </form>
        </Card>
    )
}
