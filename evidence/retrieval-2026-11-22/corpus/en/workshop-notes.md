# Fixture 10 — Workshop notes on the local index (synthetic text)

The workspace index stores chunks and vectors in one SQLite file under the workspace. Indexing reads the researcher's
files and writes only the store; a source that could not be read keeps its previously indexed version.

The index has a ceiling on how many current chunks a store may hold. A store that reached the ceiling outside the
indexing path is not silently searched in part: the verbs name the count, the limit and the way back under the limit.

Vectors are built from the chunk text already in the store, so a re-embed needs no source file and no network. A
chunk with no letter or digit produces no signature and is reported as such.
