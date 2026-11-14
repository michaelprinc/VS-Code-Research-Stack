# Analýza README a zkušeností z výzkumného pracovního prostoru

Datum: 14. listopadu 2026. Podklad pro souběžnou práci na dokumentaci; tento soubor nic nemění v README ani v produktu.

## Rozsah a míra jistoty

Posuzován je především [hlavní README](README.md), který odkazuje na [README rozšíření](extension/README.md), a lokální zdrojový stav `main` na commitu `6044f8f`; manifest uvádí verzi 0.3.12. Lokální větev se liší od `origin/main`, takže z ní samotné nelze usuzovat na aktuálně publikovanou verzi. Podle zadání se připravuje 0.3.13; v kontrolovaném manifestu však dosud není. Nepředjímám její obsah ani vydání.

Záznamy Copilotu jsou v `K:\Soukromé_aktivity\Křesťanství\.specstory\history\`: 6. 11. (`2026-11-06_05-36-14Z-dobry-den-github-copilot.md`, `2026-11-06_05-43-13Z-dobry-den-github-copilot.md`) a 14. 11. (`2026-11-14_12-45-00Z-dobry-den-github-copilot.md`). Doplňkově viz `K:\Soukromé_aktivity\Křesťanství\research\MCP-vrstva.md` a `research\Zotero-import-2026-11-14.md`. Jde o historické záznamy jedné instalace a výzkumného úkolu, nikoli nezávislou reprodukci ani doklad, že všechny operace použily 0.3.12. V dlouhých záznamech se závěry modelu vyvíjejí; jeho úvahy nejsou samy o sobě výsledkem testu.

## Zjištění z reálné práce

| Téma | Co záznam dokládá | Dopad na dokumentaci |
|---|---|---|
| Zotero přes MCP | 14. 11. volání `zotero_collections` vrátilo prázdný seznam a `readOnly: true`; to dokládá tehdejší spojení a čtení kolekcí, a společně s uživatelem potvrzeným testem přispívá k reálnému ověření prostředí; samo nepopisuje všechny ovládací prvky integračního panelu ani jednotlivé opravy 0.3.12. | Uveďte přesně čtení kolekcí a položek a přípravu RIS; přímo ze serveru Toolkit zápis do knihovny nepředstavujte jako dostupný. |
| Zápis mimo Toolkit | Copilot později zaznamenal přímé zápisy přes rozhraní Zotera a connector mimo MCP Toolkit. Jeho počáteční tvrzení, že samotné lokální API je obecně jen pro čtení, bylo v téže konverzaci opraveno. | Rozlišit omezení adapteru od možností dané verze Zotera. Externí experiment není podporovaná funkce rozšíření ani automatický import. |
| RIS a kvalita | Záznam a zpráva o importu popisují chybný import 156 položek a následnou opravu; HTTP úspěch sám neprokázal správný počet ani mapování. Zpráva také výslovně neprokázala správnost metadat či přečtení plných textů. | Přidat návod na kontrolu obsahu RIS, typů a počtů před a po importu, řešení duplicit a kontrolu metadat. Zkušenost s vlastním skriptem Copilotu neprokazuje stejnou chybu ve vestavěném generátoru RIS. |
| Lokální korpus a tvrzení | V delší relaci 6. 11. jsou zaznamenány úspěšné odpovědi `index_corpus`, perzistence a práce s odkazy na důkazy; JSON byl odmítnut jako `UNSUPPORTED_FORMAT`. Četné opakované indexace vlastního popisného souboru ukázaly, že jeho indexovaný otisk může po úpravě zastarat. | Ukázat podporované formáty, vztah zdroj–index–důkaz a použití `verify_sources` po změně. Nevydávat existenci záznamu či zdrojového odkazu za ověření pravdivosti tvrzení. |
| Vyhledávání literatury | Záznam rozlišuje nulový výsledek poskytovatele a chybu; v pracovních poznámkách je u českého dotazu OpenAlex zaznamenán stav `empty` při `ok`. | V návodu ukázat prázdnou odpověď, částečný výpadek a omezení metadat. Ani nalezené DOI samo nedokazuje správnost všech údajů nebo přístup k plnému textu. |
| Dovednosti a prostředí | Copilot načetl `theological-research`; při samostatném pokusu o Python extrakci chyběly knihovny `pypdf`, `fitz` a `pdfplumber`. To není důkaz selhání spravovaného pracovníka Toolkit. | Oddělit detekci skillu hostitelem, spuštění jeho pracovního postupu a prostředí systémového Pythonu od izolovaného workeru; záznam představuje dílčí reálné použití, nikoliv univerzální kompatibilitu. |

## Hodnocení hlavního README

1. **Rozpor o úložišti — vysoká priorita.** Sekce Phase 2 popisuje trvalou SQLite databázi a index, zatímco následující Phase 3 říká „does not yet provide … persistent storage“. Druhé tvrzení je třeba vztáhnout k historické fázi nebo nahradit aktuálním stavem. Z konverzací i současného popisu jde o skutečnou implementovanou část; úplný Research Lab a G3 tím nejsou schváleny.
2. **Příliš silná formulace o spolehlivosti.** „makes component installation reliable and visible“ a souhrn „Reading, reports … are verified through real MCP“ neříkají verzi, prostředí ani rozsah důkazu. Přeformulovat na konkrétní funkce a oddělit automatizované testy, protokolové testy a skutečné ověření v editoru, ve Windows a u poskytovatelů. Reálná konverzace je užitečným dílčím dokladem, nikoliv průchodem všech bran.
3. **Stav a časová osa se ztrácejí.** Jeden dlouhý odstavec slučuje 0.3.9–0.3.12, technické detaily a prohlášení o sítích; historická tvrzení jsou napsána v přítomném čase. Přesunout historii do changelogu a v README ponechat aktuální přehled, požadavky, stručné limity a odkazy na důkazy. V části pro sestavení zkontrolovat počet příkazů a další čísla oproti manifestu při každém vydání; momentální manifest obsahuje více příkazů než poznámka `30 commands`.
4. **Chybí mapa schopností podle důkazů.** Doplnit tabulku: funkce, prostředí a předpoklady, důkaz/verze, omezení, otevřený test. Například lokální čtení Zotera má reálný záznam, kdežto z něj nelze vyvozovat úspěch 0.3.12 GUI checku, Semantic Scholar klíče či čisté instalace na jiném stroji.
5. **Nejasná hranice mezi nastavením a dostupností.** Vysvětlit rozdíl mezi zvoleným balíčkem/presetem, nainstalovanými komponentami, dosažitelností služby a průchodem bran G1–G4. Zachovat, že brány zůstávají otevřené, dokud příslušné aktuální důkazy neprokážou opak.
6. **Síť a soukromí formulovat podle cesty.** Tvrzení o jediném síťovém JavaScriptu neznamená, že celý produkt nikdy nepřistupuje k síti: samostatně popsat kontrolu Marketplace, instalaci závislostí a výslovně vyvolané Python adaptéry služeb. Neslibovat absolutní offline režim bez vymezení příkazů a předpokladů.
7. **Oddělit průvodce a vývojovou historii.** Hlavní README jako rozcestník; README rozšíření jako stručný uživatelský návod odpovídající zabalenému VSIX; jednotlivé návody pro konkrétní kroky; changelog jako historie; evidence/specifikace jako dohledatelné důkazy a nedokončené brány. U historických plánů viditelně označit verzi a archivní status. Nevytvářet několik nezávislých „aktuálních“ seznamů schopností.

## Pokrok 0.3.12 a příprava 0.3.13

[Changelog 0.3.12](extension/CHANGELOG.md) popisuje významný opravný krok po hlášení uživatele na Windows: rozlišení odpovědí Zotera, ošetření pádu kontroly, časových limitů a souběhu, srozumitelnější `Check now`, opravu navádění pro Semantic Scholar a sjednocení verze workeru. Uvádí 481 Node a 386 Python testů a sedm kontrol panelu; jde o zaznamenané výsledky, které jsem při této analýze znovu nespouštěl. [Zpráva reprodukce](evidence/realhost-2026-11-12/README.md) vysvětluje emulovaný server. Changelog výslovně říká, že opravný běh neproběhl se skutečným Zoterem, Windows, VS Code Extension Host ani skutečným klíčem/429 Semantic Scholar. Panelový DOM shim nenahrazuje prohlížečový a přístupnostní test. Původní příčina potíží na uživatelově stroji není jednoznačně potvrzena.

Uživatel doplnil, že GUI osobně testoval a test považuje za úspěšný; toto přímé svědectví přijímám jako pozitivní zkušenost s GUI na jeho počítači. Konverzace ze 14. 11. navíc dokládá skutečné volání nástrojů a čtení Zotera přes MCP v daném pracovním prostoru. Použití MCP prokazuje fungující cestu model–nástroj, samo ale neurčuje, které prvky GUI byly vyzkoušeny; záznam zde zatím neidentifikuje verzi workeru ani jednotlivé kontroly oprav 0.3.12. Pro 0.3.13 proto doporučuji převzít a roztřídit existující důkazy, získat verzi VSIX/workeru a datovaný záznam průchodu reálným GUI na Windows; samostatně ověřit správné a chybové stavy Zotera, onboarding a případně skutečný Semantic Scholar v rozsahu uživatelova souhlasu. Poté zopakovat čistou instalaci, aktualizaci a příslušné scénáře bran podle jejich kritérií. Nic z toho neoznačovat za dokončené jen proto, že existuje plán vydání.

## Doporučené pořadí pro druhého agenta

1. Ověřit jeho aktuální pracovní větev, verzi a nejnovější důkazy; nechat historické záznamy beze změny.
2. Opravit rozpor o perzistenci a omezit nedoložená obecná tvrzení; krátce vyložit co skutečně umí MCP/Zotero/RIS.
3. Vytvořit jednu udržovanou tabulku schopností a důkazů, navázanou na existující testovací zprávy a průvodce; z README odstranit duplicity jen po zachování funkčních odkazů.
4. Před vydáním 0.3.13 aktualizovat verze, příkazy, cesty a rozsah testů podle skutečného artefaktu; odlišit plán, lokální build a publikované vydání. Prověřit odkazy a zabalený README.

Analýza neprováděla síťové dotazy, importy, změny knihovny Zotero ani testy produktu; stav knihovny a poskytovatelů se mohl od konverzace změnit.

## Doplnění: které části G01–G04 jsou doloženy

Doplněno po uživatelově potvrzení úspěšného osobního testu GUI. Starší gate reporty jsou časové snímky: jejich tehdejší věty o nedostupném Copilotu nebo Zoteru již nelze bez dalšího přenášet na pozdější relaci. Níže hodnotím konkrétní dosažené části; formální splnění celé položky vyžaduje všechny podmínky jejího akceptačního scénáře a dohledatelný záznam.

| Brána | Dokončeno nebo pozitivně doloženo | Co ještě brání uzavření |
|---|---|---|
| **G01 Basic** | Historický [G1 report](evidence/phase-1/gate-report.md) uvádí úspěch T1-01, T1-02, T1-03, T1-05, T1-05b a T1-10 v popsaném rozsahu: inventář, uzamčená instalace na jednom hostu, opakovaná inicializace, vytvoření výstupů se zachováním zdroje a lokální handoff. T1-06 má nově pozitivní důkaz reálných volání Copilotu přes MCP v pracovním prostoru. | U T1-06 doložit přesný soubor požadovaných volání a identitu instalace; částečné T1-04, T1-08 a T1-09, GitHub/auth T1-07 a druhé čisté prostředí zůstávají k posouzení. Samotná přítomnost MCP nestačí k uzavření celé brány. |
| **G02 Researcher** | [G2 report](evidence/phase-2/gate-report.md) dokládá deterministické scénáře overlaye, normalizace DOI a protokolu, nízkoobjemové odpovědi OpenAlex/Crossref a přípravu RIS. Novější konverzace přidává živé čtení kolekcí Zotera (část T2-04), vyvolání `theological-research` a reálné využití výzkumných nástrojů (část T2-07). | T2-04 požaduje také položky, import RIS do testovací knihovny a opakování včetně duplicit; zaznamenaný import mimo Toolkit není kompletním průchodem tohoto scénáře. T2-06 vyžaduje kernel ve skutečném novém okně; T2-07 všech pět skillů a celý předepsaný postup. Přetrvává posouzení poskytovatelů, chybové matice, obnovy a závislost na G01. |
| **G03 Research Lab** | Historický [G3 report](evidence/phase-3/gate-report.md) dokládá základ provenance a BM25; novější konverzace ukazuje perzistentní indexaci a práci s tvrzeními a odkazy na důkazy. Části T3-04, T3-06 a T3-07 tím získávají pozitivní praktický důkaz. | Nejde o úplné splnění těchto scénářů: zbývají zejména opakování, mutace a přerušení, všechny podmínky vazeb a exportu. Rozhodovací pravidlo vyžaduje i zmrazenou srovnávací evaluaci a zvolenou Full cestu, souběh, zálohu/obnovu, regresi a druhý čistý host; podmíněné schopnosti jsou buď ověřené, nebo výslovně vyloučené. Starý report nepopisuje novější SQLite slice. |
| **G04 VSIX** | Uživatel výslovně potvrdil úspěšnou osobní zkušenost s GUI. Záznam MCP ukazuje použití nástrojů v editoru. Historická [zpráva Phase 4](evidence/phase-4/gate-report.md) má samostatný úspěšný doklad lokálního workflow 0.3.2 a changelog uvádí automatické a balíčkové kontroly 0.3.12. To jsou pozitivní důkazy pro části preview, například T4P-10 a T4P-16, podle skutečně vykonaných kroků. | Které konkrétní ovládací prvky a přesná verze byly vyzkoušeny, zatím nebylo rozepsáno. T4P-10/16 mají více podmínek než obecný úspěšný GUI test; T4P-12 zahrnuje klávesnici, úzké rozložení, témata a chybové vstupy. Preview scénáře navíc samy nenahrazují úplné scénáře G04, včetně čisté instalace, aktualizace, obnovy a zachování dat. |

**Závěr:** Uživatelské ověření GUI a skutečné volání MCP zlepšují stav důkazů a opravují zastaralý předpoklad, že hostitelská cesta nebyla vůbec vyzkoušena. Není však doložen úplný průchod všech podmínek žádné z bran; G01–G04 proto podle stávajících pravidel zůstávají formálně otevřené. K přesnému přiřazení jednotlivých GUI kritérií stačí doplnit datum, verzi rozšíření/workeru a vyzkoušené akce a výsledky; není třeba zpochybňovat uživatelovo svědectví.

Základní kritéria: [G01](specs/phase-1/acceptance.md), [G02](specs/phase-2/acceptance.md), [G03](specs/phase-3/acceptance.md), [G04 preview](specs/phase-4/acceptance.md) a [úplný plán G04](docs/implementation/phase-4-vsix/implementation-plan.md).


## Stav po vydání 0.3.13 (14. listopadu 2026, tentýž den)

Tento text byl podkladem, ne změnou. 0.3.13 byl vydán týž den a z nalezených rozporů řeší:

- **Zápis do Zotera** je nyní součástí vlastního workeru Toolkitu, ale jen přes `zotero_write` s `preview`
  (dry-run), snapshotem do `.research-toolkit/zotero-snapshots/`, žurnálem a `undo`, s klíčem, který vydalo Zotero
  ve vlastním dialogu, a s doslovným potvrzením `write-to-zotero`. `delete` a `merge` odmítán jménem — lokální API
  žádný merge endpoint nemá. Jména `zotero_collections`, `zotero_item` a `search` zůstávají jen pro ručně psané
  MCP konfigurace.
- **Kontrola RIS před importem** je ve workeru (`validate_ris_text`, `prepare_zotero_import` odmítne vlastní
  neplatný výstup) i v bundle jako `scripts/validate_ris.py`; slovní zásoba štítků je v
  `references/zotero-vocabulary.md`. `TY - GEN` se varovně hlásí u každého záznamu.
- **Rozpor Phase 2 / Phase 3 o trvalém úložišti** v hlavním README byl opraven: věta o Phase 3 nyní říká, co
  Phase 3 opravdu neposkytuje (vektorové a hybridní vyhledávání, embeddings, Research-RAG MCP, zálohu a obnovenu),
  a přiznává SQLite store schématu 3, který shippingoval v 0.3.9 pro Full.
- **Bran G1–G4 zůstávají otevřené.** Reálný běh 14. 11. je doložen jako report v
  `evidence/realhost-2026-11-14/`, ne jako receipt brány; `evidence/gates-2026-11-07/final-validation.json`
  uvádí `"gatesApproved": []` a povinné položky G3 (Qdrant, embeddings, DuckDB) nejsou implementovány.
- **Neprovedeno:** zápis do reálné knihovny (T14-20), Extension Host a vykreslené okno (G2), reference-host
  instalace (G1), cross-platform instalace (G4).
