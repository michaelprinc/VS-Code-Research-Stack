# Doporučení pro Research Stack Toolkit 0.3.15

**Doc type: proposal, not an approved spec.** Nic z ní není implementováno ani změřeno. Vychází z toho, co
0.3.14 skutečně změnilo a co po tom zůstalo nedokázáno. Záznam stavu: [.agent/QUALITY_STATE.md](../../.agent/QUALITY_STATE.md),
přijímací tabulka 0.3.14: [acceptance.md](../phase-15-hybrid-retrieval-presets-bundles/acceptance.md).

Vycházíme z: `main` na `e4b90ac` (`45a3b0b` release, `ec47fbd` auditní opravy, `e4b90ac` záznam), bez tagu;
artifact `dist/research-stack-toolkit-0.3.14.vsix` (121 členů, 561 509 B balený, 1 710 211 B rozbalený,
strop 1 769 472 B, rezerva **59 261 B = 3,4 %**); brány 526 node / 9 panel / 444 python / `verify-package`
a `check:payload` `result: passed`.

---

## 1. Pravidla, která 0.3.15 nesmí porušit (dedičství 0.3.14)

| Id | Pravidlo | Proč 0.3.14 ho vytvořilo |
| --- | --- | --- |
| HR-34 | externí nástroj může preset nabídnout jen **pojmenovaný**; `toolsEstimate` se rovná délce seznamu | 0.3.13 publicoval „91 estimated external tools“ u presetů, které žádný seznam neměly |
| HR-35 | pokrití nástrojů se kontroluje **přes toolset**, ne počtem jmen | audit našel preset, který vybíral `assign_copilot_to_issue_with_intent`, ale jeho toolset `copilot_issue_intents` v seznamu chyběl |
| HR-36 | každý preset ≤ 20 toolkit verbs, headroom ≥ 20 nástrojů | `research-max-github-full` je na hraně přesně 20 |
| HR-37 | v textu uvnitř balíčku se nevyslovuje jméno transportu ani procesu | `verify_vsix.py` skenuje **bajty** balíčku; slovo `socket` v komentáři gate rozbilo |
| HR-38 | hash a bajtové míry se nezapisují do souboru uvnitř payloadu | troje měření 0.3.14 se hýbalo jen proto, že README o nich psalo |
| HR-39 | retired preset zůstává resolveovatelný, ale nikdy se nenabízí | `research-lab`, `research-lab-max` |
| HR-40 | archiv bundle se nepřepisuje ani nemaže; síla `force` nesmí dosáhnout na `shared-with-other-bundle` | HR-20…HR-23, DD15-04 |
| HR-41 | test se přejednává s komentářem, nemaže | label presetu v `presets.test.js` |

---

## 2. Co doporučuji udělat v 0.3.15 (pořadí podle hodnoty za riziko)

### P1 — Dokázat, že 0.3.14 skutečně běží na cizím stroji (nejvyšší priorita)
0.3.14 má 526 node testů, 9 panelových assertů a 444 python testů, ale **nic z toho neběží v reálném
Extension Hostu**: `extension/test/browser.test.js` v tomto kontejneru nikdy nespustil, `npm run test:host`
se nespustil, receipts pro Extension Host / browser renderer chybí od 0.3.9 a G1–G4 jsou otevřené.
Čtyři nová panelová tlačítka (`forceBundleUpdate`, `bundleArchives`, `restoreBundleArchive`,
`configurePresetTools`) mají za sebou jen panel renderer check.

*Co udělat:* (a) rozhodnout o Playwright jako dev-only dependenci, nebo přiznat, že `browser.test.js` je
trvale nefunkční a odstranit ho z dokladů, které na něj odkazují; (b) jeden reference-host run s **psaným
postupem a výstupy** (install → setup components → čtyři nové commandy → výpis archivů → restore) uložené do
`evidence/realhost-<date>/`; (c) doplnit do `scripts/verify_mcp.py:46` branch pro POSIX — dnes je tam
hard-coded `.venv/Scripts/research-stack-mcp.exe`, takže gate na Linuxu vůbec nejspustí.

*Doklad, který balík uzavře:* receipt s doloženými cestami + zelený `verify_mcp` na POSIX. Žádná nová funkce není potřeba.

### P2 — `tools/list` proti realitě (druhý největší dluh v upřímnosti tvrzení)
Všech 92 / 57 / 35 / 42 jmen je **počet jmen z katalogu vendoru k 2026-11-17**. Žádný `tools/list` nebyl
pořízen. To je jediné místo, kde 0.3.14 staví preset na cizím dokumentu, a zároveň nejlevnější měření.

*Co udělat:* jeden run proti `https://api.githubcopilot.com/mcp/x/all` a `…/mcp/readonly` (s tokenem
operátora, mimo tento repozitář), porovnat s [research/github-mcp-tool-map-2026-11-17.md](../../research/github-mcp-tool-map-2026-11-17.md),
rozdíly (přejmenovaná / přibyvší / zmizela jména) zapsat do mapy a do `extension/presets.json` **ve stejném
commitu**; coverage guard v `extension/test/presets.test.js` už rozběhne selhání, pokud mapa a preset
rozejdou — to je pojistka, která čeká na reálná data.

*Doklad:* pořízený list + mapa s datumem + zelený coverage test. Pokud run nejde udělat (token, síť), ať je
to zapsané jako otevřená položka, ne jako ticho.

### P3 — Kvality retrieval: měřit, ne tvrdit
0.3.14 přidal `mode = lexical | vector | hybrid`, backend `rsk-hashing-v1` (256 dimenzí, signed feature
hashing) a fusion `k = 60, 0,5 / 0,25 / 0,25`. Nikde není jediné číslo o tom, že hybrid pomáhá: žádná
prahová hodnota cosine similarity, žádné metriky rankingu, operátorův korpus (8 zdrojů / 2 067 chunks) v tomto kontejneru
není.

*Co udělat:* (a) eval harness `scripts/` nebo `tests/` — stejná sada dotazů (doporučuji 20–40, včetně
překlepů a tvarů bez diakritiky) vyhodnocená v `lexical`, `vector`, `hybrid`, side-by-side rank listy a
jejich průnik; (b) rozhodnout, jestli hybrid zůstává explicitní volbou nebo se stane defaultem — jen s
důkazem; (c) ohlásit, že hybrid je **lexical signature retrieval**, ne semantické vyhledávání.

*Doklad:* tabulka výsledků v `specs/`, případně threshold jako konstanta v `records.py` s testem. Pokud
měření ukáže, že hybrid jen přeskupuje shody, je to platný výsledek a `mode` má zůstat explicitní.

### P4 — Retrieval za hranou měřítka (skutečné riziko, zatím nepojmenované)
Dva stropy v `src/research_stack/records.py` zatím nejsou v dokladech:

* `MAX_STORE_CHUNKS = 20 000` a `embed_chunks()` načítá chunks s `LIMIT`. Korpus nad ten strop dostane
  vektory jen pro první dávku podle `source_path` a report `currentChunks` hlásí počet **načtených** řádků,
  tedy maximálně 20 000 — oříznutí se z výstupu nedá poznat.
* `search_corpus` ve `vector`/`hybrid` mode zavolá `_current_chunks_with_vectors()` a skóruje **všechny**
  chunks s vektorem v Pythonu. Při 20 000 chunks × 256 dimenzích je to full scan na dotaz.

*Co udělat:* (a) report ať jmenuje oříznutí explicitně (`chunksBeyondLimit`, `embeddedFraction`) a
`lab-state.json` ať ji replikuje; (b) u vector mode buď předfiltr kandidátů (lexical recall → vector
re-rank s pojmenovaným stropem), nebo pojmenovaná pojistka `RESULT_LIMIT`/`MAX_FUSION_POOL` s refusal
místo tichého zpomalení; (c) změřit a zapsat jednu dobu zpracování dotazu na reálném korpusu.

*Doklad:* test, který oříznutí vynutí (korpus nad strop) a cesta s refusal; jedna naměřená doba.

### P5 — Dořešit archive ergonomii bez porušení HR-40
Archivuje se `<bundleId>/<stamp>-<sequence>/`, index i log existují, restore hashově ověřuje. Chybí
ergonomie: nic neříká, kolik místa archivy zabírají, a `Show Bundle Archive History` nemá žádný limit ani
stránkování. Zároveň **nesmí** vzniknout delete command (HR-40).

*Co udělat:* (a) `listArchives` ať vrátí počet archivů a součet bajtů, panel ať hlásí „archivů N, X MB,
žádný se nemaže“; (b) history ať ukazuje posledních N a říká, že jich je víc; (c) restore ať ukáže
**preview** (které soubory se nahradí, odkud, co se archiveje) před modálem, symetricky k force-update;
(d) zdokumentovaná ruční údržba jako instrukce pro operátora, ne jako příkaz Toolkitu.

*Doklad:* test pro součet bajtů a pro „history je delší, než kolik se zobrazuje“; panelový assert pro nový text.

### P6 — Copilot výběr: ověřit, že soubor byl skutečně napsán a že ho host respektuje
`configurePresetTools` zapíše `.mcp.json` (`mcpServers.github`, per-server `tools`), marker
`//researchStackPreset`, refusaly, kopii nahrazených bajtů. Neověřeno: že soubor po zápisu opravdu
obsahuje oněch 42/92 jmen, a **vůbec** že host `tools` allow-list respektuje (vendor dokumentace, ne měření).

*Co udělat:* (a) command `verifyPresetTools` (read-only): přečte `.mcp.json`, porovná s plánem presetu a
oznámí drift pojmenovaným refusal code; (b) rozhodnout a zdokumentovat `.vscode/mcp.json` variant — formát
`servers` tool allow-list nemá, takže pro něj existuje jen local entry s `GITHUB_TOOLS`; audit už
zaznamenal, že `presetselect.js` soubor ve tvaru `servers` odmítá — ať návod říká, co má operátor udělat;
(c) jedna kontrola na reálném hostu: Copilot ať ukáže počet nástrojů serveru po změně výběru (42 vs 92), uložený do
`evidence/`.

*Doklad:* test rozdílu přečteného souboru oproti plánu + receipt z hostu. Bez (c) zůstává HR-12 z poloviny nedokázané.

### P7 — Přehash theological-research bundle (poslední soubor v balíčku, který odporuje buildu)
[extension/bundles/theological-research/references/my-library.md](../../extension/bundles/theological-research/references/my-library.md)
stále tvrdí, že Toolkit neposkytuje vector store. Je hashovaný přes `extension/bundles/catalog.json`,
proto 0.3.14 ho záměrně nechal. V 0.3.15 ať se to udělá: text podle schema 4 a retrieval módů, přehash
catalogu, navýšení verze bundle, a instalace/repair ať projde novou archive cestou — tím se funkce P3
z 0.3.14 poprvé použije na vlastním bundle.

*Doklad:* `build_bundle_catalog --check`, zelené `bundles.test.js`, zelené `check:payload`.

### P8 — Uklidit rozpočet balíčku, než někdo přidá další preset
Rezerva je **59 261 B (3,4 %)**. Další preset s plným seznamem jmen (≈ 1 KB jen za jména) nebo delší
návody strop překročí a gate selže uprostřed release.

*Co udělat:* (a) rozhodnout předem, ne v panice: buď zvýšit `MAX_UNPACKED_BYTES` s member-by-member atribucí
(DD15-10), nebo zavést rozpočet: test, který selže, když jeden člen balíčku roste o víc než pojmenovaný
limit bez atribuce v komentáři; (b) plán na odstranění tří deprecated aliases (`search`, `zotero_collections`,
`zotero_item` v `src/research_stack/recommended_server.py`, publikované jen pod `all`) a retirovaných id z
settings enum — doporučuji aliasy vyřadit až ve 0.4.0 s pojmenovaným přechodem, ne v 0.3.x.

*Doklad:* test rozpočtu + zápis rozhodnutí do `.agent/QUALITY_STATE.md`.

### P9 — Rozhodnout o pěti „planned“ komponentách, nebo přestat je tisknout v tabulkách
`extension/components.json` jich má 5 z 29: `qdrant-local-service`, `cpu-embedding-runtime-and-model`,
`duckdb-research-record-store`, `playwright-browser-capability`, `institutional-provider-adapters`. 0.3.14
ukázal, že lze dodat užitečné retrieval **bez** modelové dependance. 0.3.15 ať k každé napíše jednu
rozhodovací otázku (ne seznam funkcí): např. `cpu-embedding-runtime-and-model` — odkud model pochází, jak
se nainstaluje offline, jaký je jeho licenční a velikostní rozpočet, co dělá, když download není možný;
`duckdb-research-record-store` — co konkrétně řeší oproti SQLite cestě a co z 21 verbs by muselo zůstat.

*Doklad:* jeden odstavec rozhodnutí pro každou komponentu + `kind: "planned"` buď zůstává, nebo se mění na
`rejected` s důvodem. Žádná implementace v 0.3.15.

### P10 — Dluh, který se přenáší už tři release
`dedupe_records.py` neomezený report; T8-18 (field re-run 0.3.8); G1–G4; packaged artifact bez Changelog
assetu; `npm run test:host`; absence jakékoli cosine prahové hodnoty. Doporučuji je vzít jako jeden balík
„uzavření starých slibů“, ne jako poznamenku na konci release.

---

## 3. Co 0.3.15 nesmí tvrdit (anti-claim list)

1. Že GitHub MCP server má 92 / 57 / 35 / 42 nástrojů — dokud není `tools/list` (P2).
2. Že Copilot omezení nástrojů respektuje — dokud není host receipt (P6).
3. Že hybrid retrieval je lepší než lexical — dokud není měření (P3).
4. Že `rsk-hashing-v1` je „semantic“ nebo „vector search“ obecně — je to lexical signature.
5. Že panelové commandy byly ověřeny v editoru — dokud není Extension Host receipt (P1).
6. Že Qdrant / DuckDB / embedding model / Playwright / institutional adapters existují — `kind: "planned"`.
7. Že retrieval zvládne velký korpus — dokud není report truncace a změřený dotaz (P4).

---

## 4. Návrh acceptaních řádků (pokračování tabulky)

| Id | Kritérium | Doklad |
| --- | --- | --- |
| T16-01 | čtyři nová panelová tlačítka prokázaná v reálném Extension Hostu (ne jen renderer check) | `evidence/realhost-<date>/` |
| T16-02 | pořízený `tools/list` pro `…/mcp/x/all` i `…/mcp/readonly`, mapa a preset srovnané ve stejném commitu | mapa + zelený coverage test |
| T16-03 | lexical / vector / hybrid srovnáno na ≥ 20 dotazech, výsledek zapsán včetně „hybrid nepomáhá“ | tabulka v `specs/` |
| T16-04 | oříznutí nad `MAX_STORE_CHUNKS` je reportované pojmenovanými poli a test jej vynutí | test + pole v lab-state |
| T16-05 | `verifyPresetTools` (read-only) detekuje drift `.mcp.json` oproti plánu presetu | test + refusal code |
| T16-06 | history archivů hlásí počet a bajty, stránkuje, žádný příkaz ke smazání neexistuje | test + panelový assert |
| T16-07 | theological-research bundle přehashovaný, jeho reference odpovídá schema 4 | catalog check + payload gate |
| T16-08 | rozpočet payloadu definovaný předem, ne po selhání gate | test + rozhodnutí v QUALITY_STATE |
| T16-09 | každá planned komponenta má zapsané rozhodnutí | záznam komponenty |

## 5. Co doporučuji nedělat v 0.3.15

* Další preset bez měření (P3) nebo bez pojmenovaných nástrojů (P2) — přidání dalšího max presetu nic neověřuje.
* Delete/prune archivů — porušilo by HR-40.
* Automatická aktualizace bundle bez modálu — modál je součást bezpečnostního tvaru 0.3.14.
* Přidání python dependance (embedding model, vector DB) bez zapsaného rozhodnutí a bez rozpočtu balíčku.
* Tichá změna testu (smazání assertionu) místo přejednání s komentářem (HR-41).
