import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

/*
 * TanStack Form bound to shadcn fields: a page writes `form.AppField name=... {(field) => <field.TextField label=.../>}`
 * and gets the label, the input, the description and the errors laid out the same way everywhere.
 */

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

/** The form's submit button: disabled while the form cannot submit, with a spinner while it submits. */
function SubmitButton({ children, ...button }: Omit<ComponentProps<typeof Button>, 'type'>) {
    const form = useFormContext()
    return (
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting || button.disabled} {...button}>
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
    fieldComponents: { TextField, TextareaField, SelectField },
    formComponents: { SubmitButton },
})

/** A validator of a field that must not be blank. */
export const required =
    (message: string) =>
    ({ value }: { value: string }) =>
        value.trim() ? undefined : message
