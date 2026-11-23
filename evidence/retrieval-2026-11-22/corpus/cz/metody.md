# Fixture 04 — Metody hledání v corpus (synthetický text)

Lexikální ranker v této fixture počítá BM25: hodnotí sdílené tokeny, trestá dlouhé dokumenty a zohledňuje,
v kolika dokumentech se termín objevuje. Přesné překlepy nebo odstraněná diakritika pro něj znamenají jiný token.

Vektorový ranker počítá lexikální signaturu: sdílené tvary slov a troj- a čtyřpísmenové úseky řetězce.
Proto se „sandál“ a „sandály“ mohou blížit, zatímco synonymum bez společných písmen se blížit nemůže.

Hybridní režim oba pořadí kombinuje. Pravidlo fúze je publikované: reciproční hodnocení pořadí nese polovinu
výsledku, lexikální a vektorové skóre čtvrtinu. Hodnota kosinu se reportuje syrově, bez prahu.
