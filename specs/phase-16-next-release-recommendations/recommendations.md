# Doporučení pro Research Stack Toolkit 0.3.15

**Stav:** návrh k posouzení. Níže uvedené změny a přejímací zkoušky čekají na realizaci.
Výchozí stav uvádí [QUALITY_STATE.md](../../.agent/QUALITY_STATE.md) a
[přejímací tabulka 0.3.14](../phase-15-hybrid-retrieval-presets-bundles/acceptance.md).

Výchozí revize `e4b90ac` zachycuje vydání `45a3b0b` a auditní opravy `ec47fbd`. Lokální VSIX
0.3.14 má 121 položek, 561 509 B na disku a 1 710 211 B po rozbalení. Při stropu 1 769 472 B
zbývá **59 261 B (3,35 % stropu)**. SHA-256 lokálního souboru souhlasí se záznamem kvality.
Výsledky 526 Node testů, 9 kontrol panelu, 444 Python testů, `verify-package` a `check:payload`
pocházejí z linuxového build hostu. Doklady z referenčního VS Code a uzavření G1–G4 zůstávají otevřené.

## 1. Pravidla převzatá z 0.3.14

| Id | Pravidlo |
| --- | --- |
| HR-34 | Externí nástroje jsou pojmenované. `toolsEstimate` odpovídá délce seznamu. Katalogový a pozorovaný počet mají vlastní zdroj a kontext. |
| HR-35 | Pokrytí ověřujeme po nástrojích a podle jejich toolsetů. Jedno jméno může být publikováno ve více toolsetech. |
| HR-36 | Každý preset má nejvýše 20 nástrojů Toolkitu a alespoň 20 volných míst z rozpočtu 128. `research-max-github-full` má 16 + 92 a přesně 20 volných míst. |
| HR-37 | Balíček prochází kontrolou hranic pro spouštění procesů a síť v `verify_vsix.py`. Kontrola pracuje s bajty a její vzory mohou zasáhnout i komentář. |
| HR-38 | SHA-256, velikosti a rozpis přírůstků výsledného VSIX se zaznamenávají mimo jeho obsah. |
| HR-39 | Uložené hodnoty `research-lab` a `research-lab-max` zůstávají platné. Výběry je nenabízejí jako aktivní presety a nastavení je označuje jako vyřazené. |
| HR-40 | Před nahrazením souboru se archivují jeho původní bajty. Archiv je neměnný a force update respektuje vlastnictví jiného bundle. |
| HR-41 | Změnu očekávaného chování doprovází vysvětlení v testu a odpovídající ověření nového chování. |

## 2. Doporučený rozsah 0.3.15

Začít referenčním během P1 a opravami textů a bundle v P7. P8 vztáhnout na první úplný kandidátní
VSIX. P2 a živá část P6 sdílejí testovací účet a konfiguraci. Pokud přístup chybí, zaznamenat rozsah
neověřeného chování a ponechat odpovídající tvrzení otevřená. P3 a P4 mají dodat měření a bezpečné
chování na hranici stávajícího limitu. Změny rankingu a rozšíření archivního UI z P5 posoudit podle
výsledků a dostupné kapacity. P9 a P10 evidují rozhodnutí a zbývající podmínky.

### P1 — Referenční host, renderer a přenositelnost kontroly MCP

Stávající `npm run test:host` zkouší aktivaci, napojení webview a přetrvání nastavení. Panelová
kontrola ověřuje vykreslení tlačítek a samostatný browser test potřebuje Playwright, který chybí
v devDependencies. Spuštění těchto kontrol má odlišný rozsah od instalace vydávaného VSIX.

- Na Windows 11 x64 s referenčním VS Code použít izolovaný profil a testovací workspace. Nainstalovat
  kandidátní 0.3.15 VSIX a spustit setup a reading check. Z panelu projít Force Update, Archive
  History, Restore a Configure Preset Tools včetně zrušení potvrzení a ověření skutečných změn
  souborů po potvrzení. Pro scénář upgradu použít jako výchozí stav archiv a bundle z 0.3.14.
- Spustit `npm run test:host` přes `VSCODE_EXECUTABLE_PATH` a nový `VSCODE_TEST_ROOT`. Uvést,
  zda `EXTENSION_DEVELOPMENT_PATH` ukazuje na zdrojový strom, nebo rozbalený kandidát. Pro
  samostatný browser test zvolit uzamčenou vývojovou závislost a reprodukovatelný postup instalace
  prohlížeče, případně explicitně uvést, které scénáře přebírá skutečné webview a kde pokrytí chybí.
- Cílený běh 19. listopadu 2026 na Windows měl 68 ze 73 Node testů úspěšných. Aserce dialogu v
  `presetselect.test.js` očekává lomítko v cestě, kterou Windows formátuje se zpětným lomítkem.
  Odvodit očekávanou cestu z platformy. Další čtyři testy skončily při vytváření fixture
  s `EPERM` na symbolickém odkazu. Ověřit je na hostu, kde lze fixture vytvořit, a zachovat
  kontrolu odmítnutí odkazů.
- V `scripts/verify_mcp.py` odvodit launcher vývojového workeru podle platformy. Na Windows je
  v `.venv/Scripts/`, na POSIX v `.venv/bin/`. Ověřit i větev s existujícím izolovaným workerem
  přes `uv`, discovery, čtení souboru s mezerami a diakritikou a zápis obou výstupů.
- Do `evidence/realhost-<date>/` uložit revizi, SHA-256, verze hostu a nástrojů, vstupní fixture,
  výsledek jednotlivých scénářů a výstupy bez údajů o účtu. G1–G4 mají vlastní přejímací tabulky.

### P2 — Porovnat katalog GitHub MCP a skutečně dostupné nástroje

Čísla 92 / 57 / 35 / 42 v [mapě GitHub MCP](../../research/github-mcp-tool-map-2026-11-17.md)
jsou katalogové hodnoty z 17. listopadu 2026. Číslo 42 označuje výběr limited presetu. Podle
dokumentace GitHubu používá `/mcp/readonly` výchozí toolsety, zatímco `/mcp/x/all/readonly`
požaduje všechny dostupné read-only toolsety. [Konfigurace vzdáleného serveru](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md#url-path-parameters)

- Zachytit celé `tools/list` včetně všech stránek pro `/mcp/x/all`, `/mcp/x/all/readonly` a
  obě efektivní konfigurace z `remoteEntry()`. U limited presetu použít jeho URL
  `/mcp/readonly` a přesné hlavičky z generátoru. Uvést datum, režim autentizace, relevantní
  oprávnění účtu a neautentizační nastavení. Do evidence uložit seznamy jmen bez tokenů,
  autorizačních hlaviček a identifikátorů relace. [Specifikace stránkování](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools)
- Pro každý preset porovnat přesná jména. Chybějící vybrané jméno je rozdíl k vysvětlení,
  další jméno v nabídce serveru je kandidát k posouzení. Mapa rozlišuje lokální toolsety,
  pozorovanou nabídku vzdáleného serveru a zamýšlený výběr presetu. Nabídku Copilotu ověřuje P6.
- Pokud je třeba změnit preset, aktualizovat mapu, pojmenovaný seznam, související počty, návody
  a očekávání testů společně. Ověřit pokrytí přes toolsety, rozpočet HR-36 a absenci
  zapisovacích nástrojů v limited presetu. Nedostupné měření má stav „neověřeno“ s důvodem.

### P3 — Změřit relevanci lexical, vector a hybrid

`rsk-hashing-v1` počítá 256rozměrné lexikální signatury. Shoda rank listů sama o sobě
nevypovídá o kvalitě. Srovnání má navázat na
[T3-05 a původní cíle](../../docs/implementation/phase-3-complete/implementation-plan.md).

- Před spuštěním zmrazit korpus, nastavení indexace, alespoň 20 dotazů a nezávislé hodnocení
  relevantních pasáží. Zahrnout češtinu, angličtinu, překlepy, varianty bez diakritiky a dotazy
  bez odpovědi. Počítat Recall@10 a nDCG@10 nad stejnými pasážemi ve všech režimech, uvést
  výsledky po jazykových skupinách a u dotazů bez odpovědi četnost vrácených zásahů.
- Uložit reprodukovatelný vstup, verzi backendu, pokrytí vektory, výstupy po dotazech a tabulku
  metrik. Pokud operátorův korpus není dostupný ke sdílení, označit měření podle skutečně použitého
  korpusu. Do repozitáře patří redistribuovatelné fixture nebo souhrny bez soukromého textu.
- Pro 0.3.15 doporučuji zachovat `lexical` jako výchozí režim. Případný cosine práh nebo
  změnu defaultu navrhnout po měření a ověřit na oddělených dotazech. Částečné srovnání tří
  režimů samo neuzavírá T3-05 ani G3.

### P4 — Ujasnit chování na limitu korpusu a cenu full scanu

`index_corpus` běžný zápis nad `MAX_STORE_CHUNKS = 20 000` odmítá. `embed_chunks()` a
vyhledávací cesty však načítají s `LIMIT`. U úložiště obnoveného nebo vytvořeného mimo běžnou
indexaci by mohly vrátit výsledek z výřezu. `RESULT_LIMIT` omezuje počet vrácených výsledků a
`MAX_FUSION_POOL` zkracuje rank list pro fúzi. Ani jeden neomezuje načtení a skórování všech
použitelných vektorů v `vector` a `hybrid`.

- V témže SQLite snapshotu ověřit skutečný počet aktuálních chunků před embeddingem nebo
  vyhledáváním. Nadlimitní store odmítnout pojmenovaným výsledkem s počtem, limitem a postupem
  nápravy. U podporovaného store zachovat pořadí a kompatibilitu výstupů. Testovat přesný limit,
  překročení přes indexaci i existující nadlimitní stav vytvořený testovací fixture.
- V embedding reportu rozlišit celkový počet, zpracované či znovu použité vektory a chunky bez
  signatury. `lab-state.json` dál odvozuje stav ze SQLite, včetně limitu a existujících čítačů
  `currentChunkCount` a `scoreableChunks`. Rozlišit shodu metadat v čítačích od vektorů, které
  lze při dotazu skutečně dekódovat.
- Na typickém korpusu a syntetické fixture blízko stropu spustit všechny režimy opakovaně.
  Uvést velikost, pokrytí vektory, hardware, konfiguraci, počet opakování, medián a p95.
  Kandidátní předfiltr posoudit s P3, protože BM25 předvýběr může v režimu `vector` vyřadit
  zásahy nalezené pouze vektorovým rankerem.

### P5 — Zpřehlednit historii a potvrzení obnovy archivů

`listArchives` už vrací `count` a ověřené manifesty. Dnešní picker zobrazuje celý seznam
a potvrzovací dialog obnovy už vypisuje cesty. Přínos má doplnění velikosti, procházení delší
historie a přesné rozlišení dopadu obnovy.

- Sečíst `bytes` souborů z přijatých manifestů. Označit výsledek jako evidované bajty souborů
  a uvést počet odmítnutých položek. Zobrazit nejnovější položky a umožnit přejít ke starším.
  Výběr identifikovat dvojicí `bundleId` a `archiveId`, protože dva bundle mohou mít stejné
  ID archivu. Stránkování pickeru samo neomezuje práci na disku při čtení všech manifestů.
- Doplnit stávající potvrzení obnovy o soubory k přepsání, chybějící cíle a blokované cesty.
  Změní-li se cílové bajty po potvrzení, dotčený zápis vyžaduje nový návrh. Před zápisem
  zůstává kontrola archivovaných hashů, vlastnictví dotčených cest a archivace nahrazovaných bajtů.
- Ověřit stránkování, shodu ID mezi různými bundle, součet manifestů, zrušení dialogu a změnu
  cíle mezi náhledem a potvrzením. Archivace zůstává bez příkazu k mazání nebo prořezávání.

### P6 — Ověřit zápis presetu a výběr nástrojů v Copilotu

Dokumentace VS Code popisuje `tools` pro formát `mcpServers` v kořenovém `.mcp.json`.
Editorový `.vscode/mcp.json` používá `servers` a má vlastní pravidla předávání konfigurace.
Kompatibilitu vlastního markeru `//researchStackPreset` je potřeba prokázat v použitém
harnessu. [Konfigurace MCP ve VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

- Navržený read-only `verifyPresetTools` má použít stejný výpočet plánu i bezpečné načtení
  jako zapisovač. Po uložení ověřit přečtený soubor stejným porovnáním. Kontrolovat vlastnictví,
  variantu, přesnou množinu jmen, nepřítomnost duplicit, endpoint či příkaz a nastavení výběru a
  read-only. Ignorovat formátování JSON, pořadí v množinách a časovou značku. Výstup uvádí
  kódy a názvy rozdílů bez hodnot autentizace. Testovat chybějící, neplatný, ručně upravený
  a cizí soubor. Pro preset bez GitHubu vypsat stav případné staré definice a postup ruční kontroly.
- V návodu uvést kroky pro nativní Copilot a postup pro existující `.vscode/mcp.json`,
  včetně kontroly dvojí registrace. `GITHUB_TOOLS` v kombinaci s `GITHUB_TOOLSETS` samo
  nezaručuje přesný výběr. Uvést, který filtr a ve které vrstvě zkouška používá.
  [Skládání výběru nástrojů na serveru](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#enabling-toolsets--tools)
- Na testovacím účtu pro obě volby zachytit jména nástrojů, které Copilot v nové relaci
  skutečně nabídne pro daný server. Porovnat je s očekávanou množinou a serverovým seznamem
  z P2. Použít kontrolní konfiguraci, ve které server nabízí také alespoň jedno nepovolené
  jméno, aby výsledek ověřil přímo účinek `tools`. Uvést verzi a typ harnessu, chování
  markeru a pozorované remote/local varianty. Zkouška nepotřebuje volat zapisovací nástroje.

### P7 — Opravit popis retrieval a ověřit aktualizaci theological-research

- Opravit `references/my-library.md` v obou stromech bundle. Popsat SQLite schema 4,
  režimy a podmínku vytvoření vektorů. Upřesnit, jak standardní aktualizace zachází
  s upravenou šablonou a jak ji potvrzený force update archivuje. Zdrojový strom je
  [v templates](../../templates/skill-bundles/theology/theological-research/references/my-library.md)
  a jeho zabalená kopie je [v extension](../../extension/bundles/theological-research/references/my-library.md).
- Opravit také větu „Vector search remains planned“ v
  [diagnostice BM25](../../extension/diagnostics.js). Diagnostika má tvrdit přesně to, co její
  testovací fixture prokázala, a popsat podmínku pro vektorové režimy ve workspace store.
- Navýšit verzi tohoto bundle v `scripts/build_bundle_catalog.py`, vygenerovat katalog z
  bajtově shodných stromů a ověřit `python scripts/build_bundle_catalog.py --check`.
  Z verze 2.0 ověřit standardní upgrade neupravené kopie s archivem, zachování upravené kopie
  při běžné opravě a její potvrzený force update s obnovou původních bajtů. Doklad zahrne
  porovnání hashů z fixture, `bundles.test.js` a kontrolu skutečného VSIX.

### P8 — Změřit přírůstek a držet kompatibilitu

U prvního úplného kandidáta porovnat rozbalené velikosti po položkách s ověřeným VSIX 0.3.14,
včetně nových a odstraněných členů. Stávající `verify_vsix.py` vynucuje celkový strop. Pokud
kandidát potřebuje změnu stropu, nejprve doložit předpokládaný růst, jeho zdroj a novou rezervu
v `.agent/QUALITY_STATE.md`. Velikost samotného seznamu nástrojů nepředpovídá velikost celého balíčku.

Kompatibilitu tří deprecated aliasů (`search`, `zotero_collections`, `zotero_item` pod `all`)
a uložených vyřazených presetů zachovat v 0.3.x. Návrh odstranění pro 0.4.0 vyžaduje popis
migrace volajících a uložených nastavení.

### P9 — Rozhodnout o každé plánované komponentě

Pro každou položku z `extension/components.json` zapsat konkrétní přínos, potřebný doklad
a rozhodnutí „ponechat“, „odložit“ nebo „vyřadit“. Katalog a návody mají uvádět pouze
podporovaný stav. Vyřazení zaznamenat v rozhodnutí a prověřit návazné odkazy a kompatibilitu
ID před změnou katalogu. Hodnota `kind: "rejected"` by vyžadovala návrh změny katalogového kontraktu.
V 0.3.15 je výstupem tohoto balíku rozhodnutí pro každou komponentu.

| Komponenta | Rozhodovací otázka |
| --- | --- |
| `qdrant-local-service` | Jaký měřitelný problém stávající SQLite cesty řeší a jak se ověří synchronizace a obnova obou úložišť? |
| `cpu-embedding-runtime-and-model` | Zlepší konkrétní licencovaný model výsledky P3 v rozpočtu CPU, disku a offline instalace? |
| `duckdb-research-record-store` | Která analytická úloha potřebuje DuckDB a jak se zachová jediný zdroj zápisu a obnova záznamů? |
| `playwright-browser-capability` | Který volitelný výzkumný scénář potřebuje vlastní browser capability a jaké ověření potřebuje? Vývojová závislost pro testy P1 je samostatné rozhodnutí. |
| `institutional-provider-adapters` | Existuje konkrétní poskytovatel s dokumentovaným rozhraním, potřebným oprávněním a testovací cestou? |

### P10 — Aktualizovat stav zbývajících položek

- `dedupe_records.py`: omezit podrobný stderr výpis a zachovat souhrnné počty, úplný
  JSON výstup a návratové kódy. Pro audit umožnit získat úplný detail na vyžádání.
  Pokud se oprava vejde do P7, ověřit oba stromy bundle a velký syntetický vstup.
- [T8-18](../phase-8-utf8-stdio/acceptance.md): harness už prokázal `preexisting: true`.
  Zbývá dohledat doklad z původního workspace nebo zaznamenat, zda je jeho opakování stále možné.
- G1–G4: evidovat přesné zbývající kroky ve [stávajícím plánu bran](../../docs/implementation/README.md).
  P1 dodá doklady jen pro konkrétní provedené scénáře.
- Changelog: lokální 0.3.14 VSIX obsahuje `extension/changelog.md` i odpovídající asset
  `Microsoft.VisualStudio.Services.Content.Changelog`. Obojí zkontrolovat i v kandidátovi.
  Vykreslení Marketplace má vlastní doklad z publikované verze.
- `npm run test:host` a případný cosine práh mají přejímku v P1 a rozhodnutí v P3.

## 3. Podmínky pro tvrzení ve vydání

1. Pozorovaný počet GitHub nástrojů uvádět s datem, endpointem, účtem popsaným rozsahem
   oprávnění a použitým výběrem. U katalogu uvést datum revize.
2. Funkční výběr v Copilotu uvádět pro verzi, harness a variantu prověřené v P6.
3. Výsledky lexical, vector a hybrid vztáhnout k použitým dotazům, korpusu a změřenému pokrytí.
   `rsk-hashing-v1` popisovat jako vektorové porovnání lexikálních signatur.
4. Rozsah editorového ověření odvodit z dokladu P1. U velkých korpusů uvést změřený rozsah P4
   a platné limity. Plánované integrace uvádět v souladu s rozhodnutím P9.

## 4. Návrh přejímacích kritérií

| Id | Balík | Kritérium a doklad |
| --- | --- | --- |
| T16-01 | P1 | Instalace kandidátního VSIX a čtyři panelové scénáře v referenčním VS Code. Doklad identifikuje VSIX, host a výsledky setupu, potvrzení a zrušení. |
| T16-02 | P2 | Úplné seznamy z popsaných GitHub konfigurací, rozdíly po jménech a průchod kontroly toolsetů a rozpočtu pro případně aktualizované presety. |
| T16-03 | P3 | Výsledky všech tří režimů na stejných ≥ 20 posouzených dotazech, Recall@10, nDCG@10, jazykové skupiny a výsledky bez odpovědi. |
| T16-04 | P4 | Hraniční a nadlimitní fixture, pojmenované odmítnutí nadlimitního store, konzistentní čítače a záznam latence včetně mediánu a p95. |
| T16-05 | P6 | Read-only kontrola skutečného obsahu souboru hlásí konkrétní odchylky, toleruje nezávadné formátování a nevypisuje hodnoty autentizace. |
| T16-06 | P5 | Ověřen součet evidovaných bajtů, přístup ke starším položkám, dvojice ID, náhled obnovy, zrušení a ochrana cíle změněného po potvrzení. |
| T16-07 | P7 | Kontrola katalogu a VSIX, test diagnostiky a doklad aktualizace a obnovy bundle ze starší verze s ověřením hashů. |
| T16-08 | P8 | Kandidát má rozpis přírůstků a rezervu vůči stropu. Případná změna stropu má zdůvodnění a kandidát projde `verify-package` a `check:payload`. |
| T16-09 | P9 | Pět zaznamenaných rozhodnutí s důvodem a konzistentními odkazy v katalogu a návodech. |
| T16-10 | P1 | Výstupy `verify_mcp.py` na Windows a POSIX, `test:host` v izolaci, výsledek testů cest a linků na Windows a záznam pokrytí samostatného browser testu. |
| T16-11 | P6 | Doklad ze skutečného Copilotu uvádí přesné nabídnuté množiny, kontrolní případ, chování markeru a ověřené varianty. |
| T16-12 | P10 | Changelog a jeho asset ověřeny v kandidátovi. U deduplikace, T8-18 a G1–G4 je dohledatelný doklad nebo zaznamenaná zbývající podmínka. |

U každého řádku zaznamenat stav „ověřeno“, „otevřeno“ nebo „odloženo“, revizi a odkaz na
doklad či důvod. Kandidátní VSIX a výsledky bran jsou podkladem pro samostatné rozhodnutí o publikaci.
