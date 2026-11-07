# Lease returns ride on automatic refresh

A "return to lessor" end-of-lease decision does not raise its own swap orders. It sets the lease's
end action, and an Asset's Refresh due date becomes the earlier of its normal due date and the lease
end; the existing automatic refresh then orders the replacements, and the swapped-back units go
through the normal Return order, evaluation and return-to-lessor disposal. A dedicated lease-swap
flow would duplicate refresh ordering, successor-model choice, change approval and field work;
stock covered by the lease is moved to pending wipe, from a fresh read under the same Asset lock
claims take, and onto a draft disposal order, so it cannot be sourced again; a returned lease's units
that reach stock later are never claimed either (left out of the stock queries and refused on the
claim's fresh read under the Asset lock). Evaluation never puts a lessor-owned unit of a returned
lease back into stock: an outcome that would make it available sends it to pending wipe, as for
customer-owned units. The Refresh due dates follow later changes of a returned lease's end, and a
returned lease takes no further decision.
