import { useIsMutating } from '@tanstack/react-query'

/** One action at a time, as the page always had: a second one waits until the first has answered. */
export const useBusy = () => useIsMutating() > 0
