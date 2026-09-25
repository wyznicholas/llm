# Assertions that cannot fail

*A reference for `om-implementer`. The SKILL carries the contract and the hard rules; this file carries the how. If the two ever disagree, the SKILL wins and this one is the bug.*

`expect(find(...)).not.toBeNull()` **passes on `undefined`**, so a lookup that returns nothing satisfies it. A test written that way is vacuous: it goes green against exactly the removal it exists to catch.

T26 produced one of these — an assertion meant to prove a menu row still existed at compact width would have passed had the row been removed unconditionally, which was the entire risk of the task. It was caught before the verifier saw it, by reading the assertion rather than the result.

The same trap applies to `?.`, `.get()`, and anything else that yields `undefined` on a miss. Assert the **value**: `toBeDefined()`, `toBeTruthy()`, or better, assert what the thing *is* — its label, its position, its count.

