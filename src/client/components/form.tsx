import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
import { useId, type ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

export interface Option {
    value: string
    label: string
}

interface FieldProps {
    label: string
    description?: string
}

/** A field's errors as shadcn shows them: validators here return their message as text. */
function useFieldState<T>() {
    const field = useFieldContext<T>()
    const errors = field.state.meta.isTouched ? field.state.meta.errors.map((error) => ({ message: String(error) })) : []
    return { field, errors, invalid: errors.length > 0 }
}

function TextField({ label, description, ...input }: FieldProps & Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
    const { field, errors, invalid } = useFieldState<string>()
    return (
        <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            <Input
                id={field.name}
                name={field.name}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={invalid || undefined}
                {...input}
            />
            {description && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={errors} />
        </Field>
    )
}

function TextareaField({ label, description, ...input }: FieldProps & Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'onBlur' | 'name'>) {
    const { field, errors, invalid } = useFieldState<string>()
    return (
        <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            <Textarea
                id={field.name}
                name={field.name}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={invalid || undefined}
                {...input}
            />
            {description && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={errors} />
        </Field>
    )
}

function SelectField({ label, description, options, placeholder }: FieldProps & { options: readonly Option[]; placeholder?: string }) {
    const { field, errors, invalid } = useFieldState<string>()
    return (
        <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
            <Select items={options} value={field.state.value || null} onValueChange={(value) => field.handleChange(value ?? '')}>
                <SelectTrigger id={field.name} className="w-full" aria-invalid={invalid || undefined}>
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {description && <FieldDescription>{description}</FieldDescription>}
            <FieldError errors={errors} />
        </Field>
    )
}

function RadioField({ label, description, options }: FieldProps & { options: readonly Option[] }) {
    const { field, errors, invalid } = useFieldState<string>()
    const id = useId()
    return (
        <FieldSet data-invalid={invalid || undefined}>
            <FieldLegend variant="label">{label}</FieldLegend>
            {description && <FieldDescription>{description}</FieldDescription>}
            <RadioGroup name={field.name} value={field.state.value || null} onValueChange={(value) => field.handleChange(String(value ?? ''))} className="flex flex-wrap gap-x-4">
                {options.map((option) => (
                    <Field key={option.value} orientation="horizontal" className="w-auto">
                        <RadioGroupItem id={`${id}-${option.value}`} value={option.value} aria-invalid={invalid || undefined} />
                        <FieldLabel htmlFor={`${id}-${option.value}`} className="font-normal">
                            {option.label}
                        </FieldLabel>
                    </Field>
                ))}
            </RadioGroup>
            <FieldError errors={errors} />
        </FieldSet>
    )
}

function SubmitButton({ children, disabled, ...button }: Omit<ComponentProps<typeof Button>, 'type'>) {
    const form = useFormContext()
    return (
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting || disabled} {...button}>
                    {isSubmitting && <Spinner />}
                    {children}
                </Button>
            )}
        </form.Subscribe>
    )
}

export const { useAppForm } = createFormHook({
    fieldContext,
    formContext,
    fieldComponents: { TextField, TextareaField, SelectField, RadioField },
    formComponents: { SubmitButton },
})

export const required =
    (message: string) =>
    ({ value }: { value: string }) =>
        value.trim() ? undefined : message
