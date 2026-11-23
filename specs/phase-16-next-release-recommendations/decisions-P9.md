# P9 — Rozhodnutí o každé plánované komponentě (0.3.15)

Zapisuje rozhodnutí pro všech pět komponent s `kind: "planned"` v
[extension/components.json](../../extension/components.json), jak vyžaduje
[recommendations.md](recommendations.md) P9. Výstupem je rozhodnutí („ponechat“ / „odložit“ / „vyřadit“),
jeho důvod a doklad, na který se odkazuje. **Katalog se mění jen tam, kde to rozhodnutí vyžaduje:**
žádná komponent nedostala `kind: "rejected"` — to by podle P9 vyžadovalo návrh změny katalogového
kontraktu — a žádná `id` se nepřejmenovává, takže uložená nastavení a navazující odkazy zůstávají
platné. `reviewedAt` pěti komponent je posunut na datum tohoto rozhodnutí, `install.mode` zůstává
`"planned"` a `verify` zůstává `"none"`, protože žádná z nich neinstaluje nic, co by šlo ověřit.

Doklady, na které rozhodnutí odkazují:
[měření retrieval 2026-11-22](../../evidence/retrieval-2026-11-22/results.md) (29 posouzených dotazů,
3 režimy, latence, store na limitu),
[měření providerů 2026-11-22](../../evidence/providers-2026-11-22/) a
[host a portabilita 2026-11-22](../../evidence/host-2026-11-22/README.md).

## 1. `qdrant-local-service` — **odloženo**

**Rozhodovací otázka:** jaký měřitelný problém stávající SQLite cesty řeší a jak se ověří synchronizace
a obnova obou úložišť?

**Co je změřeno:** na korpusu 40 chunků je median `lexical` 1,09 ms, `vector` 2,68 ms, `hybrid` 3,33 ms
(p95 1,44 / 3,58 / 4,38 ms). Na store přesně na limitu 20 000 chunků je median `lexical` 253,69 ms,
`vector` 1 560,64 ms, `hybrid` 1 570,20 ms (p95 264,37 / 1 723,21 / 1 679,48 ms). Všechny tři režimy
mají na posouzených dotazech stejné **Recall@10 0,940**; nDCG@10 je 0,882 / 0,842 / 0,887. SQLite cesta
tedy není limitem kvality hledání — limitem je čas full-scanu v Pythonu, a ten je při skutečném limitu
store pod 1,6 s.

**Rozhodnutí a důvod:** žádný prokázaný problém uživatele Qdrant neřeší. Přidal by druhé úložiště,
které je třeba synchronizovat, zálohovat a obnovovat, a to je nový zdroj rozdílu mezi tím, co panel
hlásí, a tím, co store skutečně obsahuje — přesně ten druh rozdílů, který 0.3.14 v store uzavřel
(`lab-state.json` se odvozuje `SELECT`em ze stejné databáze). **Odloženo.**

**Co by rozhodnutí otevřelo:** reálný korpus nad 20 000 chunků (limit `MAX_STORE_CHUNKS`), kde lexikální
full-scan překročí řádově sekundy, plus návrh, který jasně určí, které z obou úložišť je zdroj zápisu a
jak se prokáže obnova po výpadku jednoho z nich. Bez toho je to druhá databáze bez důkazu.

## 2. `cpu-embedding-runtime-and-model` — **odloženo, s měřitelnou podmínkou**

**Rozhodovací otázka:** zlepší konkrétní licencovaný model výsledky P3 v rozpočtu CPU, disku a offline
instalace?

**Co je změřeno:** vektorový režim (`rsk-hashing-v1`, 256 dimenz, lexikální signature, žádné stahování
modelu) má na posouzených dotazech **stejné Recall@10 jako lexikální cesta (0,940)** a **nižší nDCG@10**
(0,842 proti 0,882); hybrid je 0,887. Slabá místa jsou přesně tam, kde by pomohl sémantický model:
skupina dotazů bez diakritiky nebo s překlepem má Recall 0,800 (nDCG lexikal 0,700, vector 0,626) a
`ty-01` má Recall **0,000** ve všech třech režimech. Cross-linguálně signature neziská: dotaz anglicky
neposune relevantní český passage (Precision@10 to ukazuje) a naopak.

**Rozhodnutí a důvod:** model by musel prokázat zisk právě v těchto dvou skupinách. Na syntetickém
korpusu, kde relevanční passage byla napsána pro konkrétní dotaz, žádný model žádný zisk neprokáže —
srovnání tam nemá co měřit. Druhý rozpočet, který nelze obejít, je balíček: 0.3.14 má
1 710 211 B rozbaleno ze stropu 1 769 472 B, rezerva **59 261 B (3,35 %)**; licencovaný model ani
runtime, který ho spustí, do této rezervy nevejde a offline instalace bez stahování je vlastnost,
kterou model nenabídne. **Odloženo.**

**Přeměřeno na konci řady:** kandidát 0.3.15 měří 1 882 706 B rozbaleno pod stropem 1 966 080 B, rezerva **83 374 B (4,2 % stropu)**. Rozhodnutí platí i proti novému číslu: rezerva narostla o 24 113 B, což je řádově délka dokumentu, ne licencovaný model a jeho runtime. **Odloženo i po přeměření.**

**Co by rozhodnutí otevřelo:** (1) měření na vlastním korpusu provozovatele, ne na fixture, se
stejnou sadou dotazů a se ziskem ve skupině bez diakritiky / s překlepem nebo u cross-linguálních
dotazů; (2) licence, která dovoluje zbalit model do VSIX bez stahování; (3) rozhodnutí o nové
závislosti v `pyproject.toml` a `uv.lock` — dnes oba zámky obsahují jen standardní cestu workeru.
Do té doby návody a `diagnostics.js` popisují `rsk-hashing-v1` jako **lexikální signature**, ne jako
sémantický model.

## 3. `duckdb-research-record-store` — **odloženo**

**Rozhodovací otázka:** která analytická úloha potřebuje DuckDB a jak se zachová jediný zdroj zápisu
a obnova záznamů?

**Co je změřeno:** store je schema 4 (devět tabulek včetně `chunk_vectors`) a jeho udržovací verbs
jsou prokázaná: konzistentní záloha, staged restore aktivované jen na potvrzení, potvrzený vacuum,
`claims_export` jako export tvrzení i s odkazy na důkazy. `MAX_STORE_CHUNKS = 20 000` je jmenovitý
limit a jeho překročení je odmítnuté jménem. Žádné měření v této řadě neodhalilo úlohu, kde by SQLite
selhalo — nejdražší operace je full-scan, ten je změřený výše.

**Rozhodnutí a důvod:** DuckDB by přinesel analytickou dotazovací cestu, kterou zatím nikdo nezadal, a
zaroveň dvojí zdroj zápisu. P9 vyžaduje, aby katalog uváděl pouze podporovaný stav; podporovaný stav
je „jeden SQLite store, jeden zdroj zápisu, záloha a obnova přes `store_maintenance`“. **Odloženo.**

**Co by rozhodnutí otevřelo:** konkrétní analytická úloha (agregace a join nad tvrzeními a důkazy
mimo to, co zvládne `claims_export`), nebo korpus nad limitem store, spolu s návrhem migrace, který
určuje, že zápis zůstává v jednom úložišti a druhé je odvozený a zahoditelný.

## 4. `playwright-browser-capability` — **odloženo pro výzkumnou scénář; vývojová závislost je samostatné rozhodnutí: ponecháno**

**Rozhodovací otázka:** který volitelný výzkumný scénář potřebuje vlastní browser capability a jaké
ověření potřebuje?

**Rozhodnutí pro capability:** žádný výzkumný scénář, který by provozovatel zadal, browser capability
nevyžaduje; katalog zůstává `kind: "planned"`, `install.mode: "planned"`, `verify: "none"` a žádný
návod neříká, že je dostupná. **Odloženo.**

**Samostatné rozhodnutí (vývojová závislost): ponecháno.** `npm run test:browser` je od 0.3.15
skutečně vykonatelný test: Playwright je uzamčená vývojová závislost
(`"playwright": "1.65.1"` v `devDependencies` v [extension/package.json](../../extension/package.json)),
test vykresluje shipping panel v Chromium a jeho výsledek i meze pokrytí jsou zaznamenány v
[evidence/host-2026-11-22/README.md](../../evidence/host-2026-11-22/README.md). Proti balíčku je to
uzamčené dvakrát: `extension/test/unit.test.js` kontroluje, že manifest uvnitř VSIX neobsahuje
`devDependencies`, a `scripts/verify_vsix.py` pokládá `devDependencies` za vývojové pole. Není to
browser capability pro provozovatele a nesmí se tak v návodech objevit.

**Co by rozhodnutí otevřelo:** zadání konkrétního scénáře (která stránka, jaký výstup, jak se ověří,
že čtení z prohlížeče vstoupí do store se stopou původu) a rozhodnutí o CSP a o klíčích.

## 5. `institutional-provider-adapters` — **odloženo**

**Rozhodovací otázka:** existuje konkrétní poskytovatel s dokumentovaným rozhraním, potřebným
oprávněním a testovací cestou?

**Co je změřeno:** tři shipping providery jsou měřené — Crossref odpovídá 200, OpenAlex 200,
Semantic Scholar anonymous 429 ([evidence/providers-2026-11-22](../../evidence/providers-2026-11-22/)).
Odmítavé stavy jsou jmenné (`PROVIDER_TERMS_NOT_ACKNOWLEDGED`, `429` jako limit, ne jako ztracený
účet) a stavy přístupu v RIS jsou konzistentní. Žádný institucionální provider nemá v těchto
podkladech dokumentované rozhrání, ověřené oprávnění provozovatele ani testovací cestu.

**Rozhodnutí a důvod:** adapter bez legitimovaného oprávnění a bez testovací cesty by do balíčku
přinesel konfiguraci, kterou nelze ověřit, a oprávnění, které Toolkit nemůže vydat. **Odloženo.**

**Co by rozhodnutí otevřelo:** jméno poskytovatele, jeho dokumentaci, typ oprávnění (předplatné,
institutionální token, OpenAthens/Shibboleth) a test, který nepoužívá sdílený klíč; teprve pak
`install.mode` přestane být `"planned"`.

## Souhlas katalogu a návodů

| `id` | `kind` v katalogu | Rozhodnutí | `reviewedAt` |
|---|---|---|---|
| `qdrant-local-service` | `planned` | odloženo | 2026-11-22 |
| `cpu-embedding-runtime-and-model` | `planned` | odloženo (měřitelná podmínka) | 2026-11-22 |
| `duckdb-research-record-store` | `planned` | odloženo | 2026-11-22 |
| `playwright-browser-capability` | `planned` | odloženo; vývojová závislost ponechána | 2026-11-22 |
| `institutional-provider-adapters` | `planned` | odloženo | 2026-11-22 |

Co se v katalogu skutečně změnilo: jen `reviewedAt` pěti komponent na datum rozhodnutí. `kind`,
`install.mode`, `verify` ani `nextAction` se nemění — žádná z pěti neinstaluje nic, co by šlo ověřit,
žádná nedostala `kind: "rejected"`, žádná `id` se nepřejmenovává, takže uložená nastavení a navazující
odkazy zůstávají platné. `reviewedAt` nikde v kódu není čteno; je to údaj katalogu pro člověka.

Návody `extension/guides/{qdrant-local-service,cpu-embedding-runtime-and-model,duckdb-research-record-store,playwright-browser-capability,institutional-provider-adapters}.md` **upraveny nebyly** — toto rozhodnutí je záznam pro vydání, ne text, který balíček distribuuje. Jejich tvrzení („není implementováno, žádný model se nestahuje, žádná třetí databáze se neinstaluje, „Not implemented in the toolkit; …") zůstávají v platnosti, protože odpovídají skutečnému stavu balíčku; rozšířit je o rozhodnutí by znamenalo měnit shipping text bez důkazu, který by podporoval. Odkaz na toto rozhodnutí je tedy v [recommendations.md](recommendations.md) a v [.agent/QUALITY_STATE.md](../../.agent/QUALITY_STATE.md), ne uvnitř VSIX.

Co se tímto rozhodnutím **nesmí** změnit a také nezměnilo: žádný preset, žádný MCP verb, žádný příkaz,
žádný rozpočet serverů (8 / 5 / 10) ani strop 20 nástrojů presety.
