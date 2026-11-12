import { useIsMutating } from '@tanstack/react-query'

export const useBusy = () => useIsMutating() > 0
