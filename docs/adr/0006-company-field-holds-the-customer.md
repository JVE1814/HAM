# The company field holds the Customer

On Assets, `company` is the Customer (a CSM account) while the Asset is assigned or reserved for
them, and the Provider's own company while it is unassigned stock. Who legally owns the Asset is a
separate scoped field (`x_daas_ham_legal_owner`: provider / customer / lessor). Putting the Provider
in `company` permanently would have made every out-of-box visibility rule and report blind to the
Customer. There is no domain separation.
