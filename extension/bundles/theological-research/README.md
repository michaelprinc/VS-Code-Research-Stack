# Teologická rešerše - skill

Adresář je jeden skill ve formátu Agent Skills: adresář `theological-research/` soubor `SKILL.md` a podpůrné soubory.

## Struktura

```
theological-research/
├── SKILL.md                          # metadata + postup (načte se, když se skill aktivuje)
├── references/
│   ├── methods.md                    # exegeze, patristika, historická a systematická teologie
│   ├── source-evaluation.md          # typy pramenů, status přístupu, tabulka hodnocení
│   ├── citation-standards.md         # normalizace, DOI, citace, lokátory
│   ├── theology-and-social-sciences.md  # empirické a sociálněvědní podklady
│   ├── my-library.md                 # VYPLNIT: co skutečně máte přístupně
│   └── report-templates.md           # kostry výstupů
├── scripts/
│   ├── crossref_lookup.py            # ověření záznamu (Crossref, pak OpenAlex)
│   └── dedupe_records.py             # deduplikace a flag podezřelých záznamů
└── evals/
    └── evals.json                    # 4 testovací scénáře
```

## Pravidla, která formát vyžaduje

- Soubor se jmenuje `SKILL.md` (velká písmena), adresář se jmenuje stejně jako pole `name`.
- `name`: max 64 znaků, jen malá písmena, číslice a pomlčky, bez pomlčky na začátku nebo konci.
- `description`: max 1024 znaků, musí říct **co** skill dělá a **kdy** se má použít, ve třetí osobě.
- Tělo `SKILL.md` pod 500 řádků; detaily patří do `references/`.
- Odkazy v `SKILL.md` jen jednu úroveň hluboko. Soubory delší než 100 řádků mají obsah nahoře.
- Cesty vždy s lomítkem (`references/methods.md`), nikdy s obráceným lomítkem.

## Kde skill leží, aby ho produkt našel

Různé produkty hledají skills v různých adresářích. Ověřte si to ve své verzi:

- Claude Code: `~/.claude/skills/<skill-name>/SKILL.md` (osobní) nebo `.claude/skills/<skill-name>/SKILL.md` (projektový)
- Claude API: skills se nahrávají jako souborový balíček
- VS Code / jiné nástroje: liší se; skill je jen adresář, takže funguje kdekoli, kde nástroj umí přečíst `SKILL.md`

## Ověření formátu

```bash
npx --yes skills-ref validate ./theological-research
```

(Jen pro vývoj skillu: stahuje balíček `skills-ref` z npm registry. Toolkit ani instalátor tento příkaz nespouštějí.)

## Skripty

```bash
python3 scripts/crossref_lookup.py "Přesný název díla" --author Příjmení --year 2015 --mailto vas.e-mail@example.org
python3 scripts/dedupe_records.py ./records.json > records.deduped.json
```

Oba skripty spouštíte vy (nebo asistent, se kterým pracujete) z příkazové řádky. **Instalátor toolkitu ani ovládací panel žádný z nich nespustí**; instalace balance žádný síťový požadavek nevykoná.

`crossref_lookup.py` posílá HTTPS požadavky na `api.crossref.org` a `api.openalex.org`. Neposílá žádné přihlašovací údaje. V `User-Agent` je záměrně **zástupná (placeholder) kontaktní adresa** — nahraďte ji, nebo předejte vlastní adresu přes `--mailto`.

Návratové kódy `crossref_lookup.py` — výpadek služby je odlišen od „nic nenalezeno“:

| Kód | Význam |
|---|---|
| 0 | nalezen pravděpodobný kandidát, autor i rok sedí, všechny dotázané služby odpověděly |
| 2 | ŽÁDNÝ PRAVDĚPODOBNÝ KANDIDÁT — služby odpověděly, nic neodpovídalo |
| 3 | VÝPADEK SLUŽBY, žádný kandidát — vyhledávání neproběhlo |
| 4 | kandidát nalezen, ale alespoň jedna služba selhala — částečný důkaz, ne ověření |
| 5 | kandidát nalezen, ale autor nebo rok neodpovídá — prohlédněte a rozhodněte sami |

Návratové kódy `dedupe_records.py`: 0 = čisté, 1 = vyžaduje revizi (něco vynecháno nebo označeno), 2 = špatný vstup. Skript na stderr vypíše **každý záznam, který vynechal, a důvod**, a shrnutí uvádí počet vstupních a výstupních záznamů. Porovnává jen `title` a `doi` (DOI v holém tvaru; `https://doi.org/…` a `10.…` je tentýž identifikátor); `authors` neporovnává a `year` slouží jen k poznámce u podobných titulů. Výstup je pracovní návrh k revizi, ne ověřený seznam.

Výchozí vstupní cesta `records.json` se hledá v **aktuálním pracovním adresáři**, ne v adresáři skillu — předejte cestu explicitně.

Skripty používají jen standardní knihovnu Pythonu a potřebují Python 3.12 nebo novější.

## Jak skill dále vyvíjet

1. Vyplňte `references/my-library.md` - to je nejcennější část, protože model neví, co máte přístupně.
2. Otestujte na skutečné úloze bez skillu, pak se skillem; porovnejte výstupy.
3. Sledujte, které soubory model skutečně otevře. Pokud soubor nikdo neotevře, buď je zbytečný, nebo špatně na něj odkazuje.
4. Každou změnu udělejte v jedné věci a ověřte ji na jednom z `evals/evals.json`.
5. Držte verzi v `metadata.version` a každou změnu commitněte s popisem, co se změnilo a proč.
