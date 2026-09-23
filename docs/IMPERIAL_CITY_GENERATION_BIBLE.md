# Imperial City Generation Bible

**Purpose:** Human-readable worldbuilding input for RUBY_WHEEL procedural generation.  
**Status:** GM-accepted human-readable world specification for RUBY_WHEEL and auxiliary generation tools. It is not itself the runtime generation profile and does not override `docs/REQUIREMENTS.md` or `docs/ARCHITECTURE.md`. Detailed procedural parameters may be derived by AI/software from this specification unless they would alter established canon or a protected hard anchor.

## Authority and labels

Use the following labels throughout this document:

- **ESTABLISHED CANON** — directly established in current campaign/project material or explicit GM decision.
- **STRONG WORKING MODEL** — repeatedly supported and suitable for generation unless later revised.
- **PROPOSED GENERATION LANGUAGE** — a procedural-design interpretation, not yet campaign canon.
- **OPEN QUESTION** — deliberately unresolved and consequential enough to surface to the GM.
- **AI / PROCEDURAL SYNTHESIS RESPONSIBILITY** — detail that should be derived from established canon and working models by RUBY_WHEEL, an auxiliary generator, or an AI-assisted authoring step rather than hand-specified by the GM.

Source priority when materials disagree:

1. Current RUBY_WHEEL requirements/architecture and explicit current GM decisions.
2. Current *Imperial City Interregnum Campaign Bible* items marked established canon.
3. Active-table material and house briefings.
4. Older campaign documents such as *Breaking the Interregnum: Cyrodiil*.
5. Working models and new proposals in this document.

**Important current scale override:** current RUBY_WHEEL canon is 1 source pixel = 3 m; 1 world unit = 5 ft = 1.524 m; exterior-wall span = 6,744 m E–W and N–S. Older campaign-bible scale figures must not silently override this.

## Division of labor

The GM defines the **high-level truth** of the city: established canon, broad cultural inspirations, district identities, major exceptions, protected sites, and whether generated output feels wrong. The GM is **not** expected to hand-author the parameter distributions required to fill a megacity.

RUBY_WHEEL, auxiliary software, and AI-assisted generation are responsible for deriving lower-level detail such as:

- culture-mixing weights and component inheritance;
- façade, material, roof, courtyard, gate, and garden parameter sets;
- household/property distribution below the level of explicitly authored houses;
- crop allocation on individual suitable plots;
- cuisine menus, vendors, ordinary workshops, and neighborhood services;
- reusable procedural/parametric 3D component kits;
- ordinary building archetypes and deterministic variation;
- the majority of island/block/building-level worldbuilding.

Derived detail should remain traceable to its parent district/culture/economic constraints and should be deterministic when generated from the same accepted inputs and seed. Only consequential ambiguity or contradiction should be escalated to the GM.

---

# 1. Citywide Identity

## 1.1 Core feel

**ESTABLISHED CANON**

The Imperial City is a continental capital built across hundreds of islands and broad waterways. It is not a small Venice analogue enlarged to fantasy scale. The eight inner districts are each functional cities surrounding White-Gold, and outer districts/island chains connect the inner city to military, mercantile, magical, agrarian, and regional networks.

The city is cosmopolitan Heartlander territory shaped by continual Colovian, Nibenese, Akaviri, Nordic, Ayleid, religious, guild, merchant, and immigrant influence. Cultural geography does not map neatly to physical east/west geography.

The eastern inner-city sector trends toward working infrastructure — Legion, Arena, Industry, and the Arboretum — while the western sector trends toward prestige, legitimation, administration, refinement, and consumption — Artisan, Nobles, Temple, and the upper face of Market. This is an economic pattern, not a racial zoning rule.

## 1.2 Vertical urbanism

**STRONG WORKING MODEL**

The city is dense and vertical because land is scarce and canals constrain plots.

- Poor/working areas: commonly 3–5 stories; durable lower floors with denser upper occupation; shops/workshops below and cramped housing above.
- Merchant/middle-class areas: commonly 4–6 stories; courtyard blocks; warehousing/shops/offices/housing vertically mixed.
- Elite areas: commonly 3–5 stories but consume more land; gardens, courts, servant wings, monumental fronts.
- Exceptional state/Guild/Ayleid-supported complexes: 6–8+ stories or stranger.
- Arcane District: ordinary density may coexist with floating, suspended, moving, or magically stabilized structures.

## 1.3 Water, bridges, and movement

**ESTABLISHED / STRONG WORKING MODEL**

Waterways range from narrow neighborhood canals to urban-river-scale channels. Shorelines are active edges: moorings, ferry stages, barges, fish pens, floating workshops, inspection points, and quays reduce the apparent open-water width.

Crossings form a hierarchy rather than every gap receiving a bridge:

- local bridges: roughly 5–30 m;
- important district bridges: roughly 30–80 m;
- grand/strategic bridges: roughly 80–150+ m;
- ferry-only gaps are normal and preserve waterborne culture.

The great walls are inhabited linear fortresses and military highways, not simple perimeter meshes. Wall towers can behave as miniature forts; water posterns combine gates, chains/booms, inspectors, towers, and narrow controlled access.

## 1.4 Subsidence and age

**STRONG WORKING MODEL**

The city sits on islands, fill, wet sediment, ancient foundations, and Ayleid infrastructure. Uneven settling creates raised streets over older streets, damp or flooded former ground floors, failed sewer gradients, pumps, retaining works, and class-differentiated flood protection. This should create vertical historical layering rather than one clean construction era.

---

# 2. Cultural Architectural Vocabularies

These cultural vocabularies are **not district templates**. A district supplies urban/economic context; an individual household, institution, neighborhood, or building may express a different cultural inheritance.

## 2.1 Heartlander

**GM DIRECTION:** Roman / Imperial core.

**STRONG WORKING MODEL / AI-SYNTHESIS INPUT**

Use the Heartlander vocabulary as the shared metropolitan/civic substrate rather than as a monopoly on any district.

Likely cues:

- masonry-first urban construction;
- arcades, courtyards, colonnaded public fronts, formal axes and processional approaches;
- tiled or low-to-moderate roof forms where appropriate;
- repetitive façade bays and street walls in dense urban areas;
- apartment/courtyard blocks, bath complexes, basilica-like civic halls, warehouses, barracks, forums/squares;
- strong use of public inscriptions, standards, statuary, fountains, official seals, and imperial iconography;
- engineered quays, roads, drains, cisterns, and bridges as visible civic architecture.

Heartlander should read as **metropolitan Imperial**, not “vanilla European.”

## 2.2 Colovian

**ESTABLISHED CULTURAL DIRECTION:** practical, martial, honor/loyalty oriented, strong knightly and military traditions; influence moves through grain, veteran networks, military alliances, mercenaries, and practical-order politics.

**GM DIRECTION:** Germano-Roman.

**STRONG WORKING MODEL / AI-SYNTHESIS INPUT**

Likely cues:

- Roman/Imperial structural inheritance combined with more defensive, austere, heavy, practical forms;
- stronger gables/steeper roofs in selected building families;
- stone bases, robust timber/brick upper work where class/function permits;
- walled yards, gatehouses, halls, barrack-like courts, towers, armories, stables;
- fewer delicate façade gestures than elite Nibenese work; ornament concentrated on heraldry, military memory, cult, and household status;
- fortification language can bleed into manor, guild, veterans’ hall, granary, and caravan architecture.

Colovian does **not** mean poor or crude. Elite Colovian architecture can be monumental and sophisticated while remaining restrained and martial.

## 2.3 Nibenese

**ESTABLISHED CULTURAL DIRECTION:** eclectic, urban, mercantile, magical, bureaucratic, ceremonial; influence travels through trade, noble families, finance, magical education, cults, and patronage. Nibenese cities and river culture support great wealth and dense urban life.

**GM DIRECTION:** Greek blended with Akaviri/Japanese influence.

**STRONG WORKING MODEL / AI-SYNTHESIS INPUT**

Treat Nibenese architecture as a cosmopolitan eastern Imperial tradition, not simply “Japanese fantasy.” A useful baseline blend is:

- Hellenic/Hellenistic-inspired courtyard, terrace, colonnade, stoa, garden, and civic frontage logic;
- strong outdoor/indoor transitions suitable to a warmer river culture;
- plastered/color-rich masonry, decorative stone, patterned courts, shrines, commercial galleries;
- household compounds built around courts and gardens at higher wealth levels;
- Akaviri-derived roof, gate, gallery, screen, garden, and ceremonial motifs appearing with varying strength;
- mercantile buildings designed around ledgers, receiving courts, storage, offices, household shrines, and client access;
- cultivated visual display in elite houses without implying that every Nibenese industrial building is elegant.

Nibenese influence in Industry may appear chiefly in ownership, commercial organization, shrine placement, courtyard logistics, offices, and merchant compounds rather than ornate façades.

## 2.4 Akaviri

**ESTABLISHED CAMPAIGN CONTEXT:** Akaviri influence is historically deep. Arena once held many Akaviri residents; pogroms and confiscations left abandoned compounds, hidden shrines, mixed families, surviving architectural traces, and erased histories. Mixed Akaviri ancestry also exists in Industry and Nobles.

**STRONG WORKING MODEL / AI-SYNTHESIS INPUT**

Akaviri should be a distinct component vocabulary that can survive inside otherwise Heartlander/Nibenese buildings:

- pronounced roof/eave and gate vocabulary;
- timber galleries/verandas and carefully framed thresholds;
- enclosed or layered gardens/courts;
- screen-like partitions or façade elements where materially appropriate;
- vertical gate markers, household shrines, memorial stones, martial display, and swordsman/training spaces;
- more deliberate relationship between path, gate, courtyard, garden, and principal hall.

Do not require a full Akaviri building whenever Akaviri heritage is present. After centuries of intermarriage, an Akaviri-influenced household may retain only particular inherited components.

## 2.5 Mixed buildings and households

**CORE GENERATION RULE — STRONG WORKING MODEL / AI-SYNTHESIS RESPONSIBILITY**

Do not blend cultural styles by averaging every parameter. Use **component inheritance**.

A building/compound should have:

1. a **primary structural vocabulary** controlling massing/plan;
2. one or more **secondary cultural vocabularies** controlling selected components;
3. a **district context** controlling density, lot pressure, street relationship, infrastructure, pollution, prestige, and land use;
4. an **owner/household identity** controlling cultural expression, wealth, religion, security, and special functions;
5. an **age/history layer** controlling additions, confiscation, renovation, decay, or adaptive reuse.

Example — Nibenese-Akaviri noble house in Nobles District:

- Nobles District: large lot, high surveillance, garden/service wings, elite frontage;
- primary Nibenese plan: courtyard/compound organization and ceremonial reception;
- Akaviri inheritance: gate, roofline, garden sequence, shrine, swordsman court;
- Heartlander city substrate: quay/road interfaces, masonry services, drainage, legal frontage conventions;
- house history: later additions may be stylistically different.

A neighboring Colovian house on the same island should share district infrastructure and wealth but not the same roof/compound grammar.

The exact probabilities, roof angles, façade-bay widths, material frequencies, and component-selection weights are **not GM-authored canon**. They are implementation data to be derived, tested visually, and revised by the generator/AI while preserving the recognizable cultural direction above. Mixing should be historical and component-based rather than a uniform numeric average.

---

# 3. Inner District Profiles

## 3.1 Legion District

**Feel:** disciplined, loud, smoky, martial, practical, politically sensitive.  
**Primary functions:** military industry, naval supply, strategic production, veterans.  
**Cultural tendency:** strongly Colovian-leaning despite eastern location.  
**Built fabric:** arsenals, repair yards, military warehouses, drydocks, long ropewalks, metalworking, armories, veteran housing, barracks, supply courts, ship fittings, stables.  
**Generator implications:** robust street/yard access; large industrial footprints; direct land/water military corridors; firebreaks and secure compounds; ordinary housing still required around strategic works.  
**Food/logistics:** enormous institutional demand for food, leather, hemp, timber, charcoal, pitch, iron; mess halls, bakeries, storehouses, ration depots and local markets should exist even though the district identity is military.

## 3.2 Arena District

**Feel:** theatrical, aspirational, crowded, volatile, festive, dangerous, Nibenese-facing.  
**Primary functions:** arena entertainment, betting, hospitality, lending, fighter economy, spectacle.  
**Cultural tendency:** major Nibenese center with substantial Akaviri historical residue.  
**Built fabric:** Arena complex, fight schools, theaters, inns/hostels, taverns, stables, surgeons, bookmakers/lenders, merchant warehouses, festival streets, confiscated or repurposed Akaviri compounds, hidden shrines.  
**Generator implications:** high pedestrian peaks; public squares and routes sized for events; nightlife/service density; mixed wealthy eastern merchants beside poorer entertainment labor; occasional historical Akaviri fabric should survive inside later reuse.  
**Food:** established imports include Nibenese rice and alcohol; entertainment streets should support abundant prepared food/drink vendors, taverns, feast businesses, cheap worker meals and luxury boxes/hospitality.

## 3.3 Industry District

**Feel:** indispensable, dirty, profitable, socially disdained, dangerous, brutally organized.  
**Primary functions:** tanneries, dye works, rendering, soap/glue, ore concentration, low-grade smelting, alchemical/chemical bulk processing, waste trades.  
**Cultural tendency:** significant Nibenese merchant capital and practical commercial organization; not necessarily elegant.  
**Built fabric:** dense workshops, furnace yards, sheds, bulk storage, contaminated channels, worker housing, offices/counting rooms, protection-racket territory, industrial quays, fire infrastructure.  
**Generator implications:** pollution externalities matter spatially; large service yards and canal access; worker housing intermixed with production; hard separation from “pretty Nibenese = clean” assumptions.  
**Food:** cheap dense worker food, local markets, taverns, preserved foods and institutional kitchens matter more than agriculture; pollution constrains edible cultivation.

## 3.4 Arboretum

**Feel:** humid, quiet relative to neighbors, green but engineered, specialized, liminal.  
**Primary functions:** water treatment, flood buffering, controlled wetlands, alchemical/medicinal cultivation.  
**Built fabric:** channels, settling basins, reed beds, nurseries, controlled marshes, laboratories, maintenance settlements, shrines, locks, overflow basins, sparse residential islands.  
**Generator implications:** do not generate it as a decorative park. Water-management geometry dominates ordinary street grids. Settlement should cluster around maintenance/research nodes.  
**Food/agriculture:** food is not the primary crop. Dominant cultivation is non-food: alchemy, medicine, dyes, fibers, perfumes, ritual/magical research. Edible agriculture using treated water requires stricter siting and oversight.

## 3.5 Temple District

**Feel:** beautiful, crowded, ordered, musical/bell-filled, ceremonial, charitable, politically divided.  
**Primary functions:** religion, pilgrimage, mortuary work, archives, charity, relief, education, ritual finance, ceremonial ingress.  
**Built fabric:** Temple of the One, chapels, shrines, cult houses, hospices, schools, archives, hostels, mortuary institutions, processional spaces, chandleries, scriptoriums, tailors, incense houses, kitchens, grain stores.  
**Generator implications:** processional routes and water approaches are first-class; religious campuses vary greatly in size; many small cult/shrine buildings coexist with enormous landmarks.  
**Food:** temple kitchens, charity food, pilgrim lodging, sacred/communal feasts, grain holdings and emergency relief are core urban functions rather than decorative flavor.

## 3.6 Market District

**Feel:** loud, muddy, transactional, cosmopolitan, highly organized beneath apparent chaos; refinement above and freight below.  
**Primary functions:** storage, division, finance, insurance, weighing, taxation, customs, redistribution.  
**Built fabric:** bonded warehouses, counting houses, moneychangers, banks/credit houses, auction halls, inns, labor markets, caravan yards, freight docks, granaries, customs compounds.  
**Generator implications:** high mixed-use verticality; freight lanes/yards/quays; public commercial gravity wells; upper-story offices and prestigious façades may sit over hard-working yards.  
**Food:** one of the city’s two largest redistribution nodes; wholesale grain/food infrastructure and many secondary/local markets. Merchants prioritize food security and predictable tolls.

## 3.7 Nobles District

**Feel:** prestigious, quieter, maintained, surveilled, politically tense, privately disordered.  
**Primary functions:** elite residence, household politics, embassies, prestige services, influence brokerage.  
**Built fabric:** mansions, walled compounds, elite townhouses, shrines, servant quarters, stables, gardens, baths, schools, embassies, specialty shops, small warehouses — plus ordinary service neighborhoods.  
**Cultural composition:** deliberately mixed. Colovian, Heartlander, Nibenese, Nibenese-Akaviri and other elite households may occupy neighboring islands or streets. District identity must not overwrite house identity.  
**Generator implications:** use district-wide wealth/security/maintenance parameters, then assign individual estates/blocks household cultural vocabularies. Generate service neighborhoods and workers, not a continuous palace zone.  
**Active canon:** House Krotolous is Nibenese with Akaviri ancestry and resides here.

## 3.8 Artisan District

**Feel:** skilled, prosperous, guild-conscious, cleaner than Industry, busy with transformation rather than bulk extraction.  
**Primary functions:** prestige crafts, fine production, food-chain equipment/processing, magical certification bureaucracy.  
**Built fabric:** fine metal shops, glass/ceramic works, bookmaking, instruments, jewelry, furniture, precision tools, guild halls, showrooms, workshops, kilns/furnaces at controlled scales, bakeries/breweries/distilleries, barrel/storage-vessel making, wagon/harness shops.  
**Generator implications:** workshop-residence hybrids, guild clusters, cleaner production courts, retail frontage, apprentice housing, specialist streets.  
**Food/agriculture:** connected to Agrarian Estates; processes/maintains the tools and containers of the food system and hosts baking, brewing, distilling and agricultural repair.

## 3.9 White-Gold District

**Feel:** administrative city, sacred precinct, ceremonial center, bureaucratic machine, symbolic center of gravity.  
**Primary functions:** Tower, Elder Council, courts, treasury/mint functions, archives, diplomacy, military planning, sacred/dynastic ritual, high-security docks and service infrastructure.  
**Generator implications:** strongest Heartlander/Imperial civic grammar; broad controlled/processional spaces near the Tower; successive government/service rings; ordinary clerks, servants, guards, petitioners, suppliers and families must prevent it becoming an empty monument park.  
**Caution:** older working dimensions for White-Gold conflict with current project-wide scale decisions; do not bake obsolete numeric dimensions into generation profiles without explicit review.

---

# 4. Outer District / Island-Chain Profiles

## Nibenese District

**Established role:** eastern mercantile/cultural gateway to Nibenay; ships, merchants, communities, patronage networks.  
**Generation direction:** strongest concentration of Nibenese architectural/cuisine palettes; should still contain Imperial/Heartlander substrate and mixed populations.

## Arcane District

**Established role:** University/Guild city linked to Arboretum; magical infrastructure woven into ordinary life.  
**Visual identity:** projected sky; floating lights; moving bridges; floating/drifting housing; luminous grids/diagrams/overlays; architecture that can behave like information — while retaining ordinary markets, food, docks, workers and neighborhoods.  
**Active canon:** House Runellius resides here.

**Strong agricultural working model from prior campaign planning:** roughly **25–35% of visible land should read as productive green land** rather than generic landscaping. Of that productive land, a useful strategic mix is approximately:

- **50–60% rice / wet cultivation**, concentrated on broad low islands and intentionally flooded paddies;
- **15–20% legumes / raised-bed staples**, including chickpeas or comparable pulses on drier ground;
- **10–15% vegetables and greens** for local markets;
- **5–10% alchemical, medicinal, or experimental cultivation**;
- **5–10% orchards, lotus/specialty gardens, and demonstration horticulture**.

Taro belongs at wet margins and in paddy-like cultivation. Orchards should be concentrated on suitable outer islands, walled institutional or noble gardens, and experimental horticultural sites rather than spread uniformly. This is a district-scale target, not a requirement that every island contain farming.

## Waterfront District

**Established role:** principal large-ship port, bulk food/customs/transfer/quarantine gateway.  
**Generation direction:** engineered quays, cranes, slips, bonded yards, warehouses, granaries, customs, quarantine, ferry/patrol/repair basins; shipping magnates and Nibenese political influence.

## Colovian District

**Established role:** western cultural and caravan presence linked to the Great Weye approach and lake routes.  
**Generation direction:** strongest Colovian architecture/food/household palette, but still metropolitan and mixed.

## Agrarian Estates island chain

**Established role:** linked to Artisan; estates, food production, mills, agricultural services, elite rural holdings, grain-chain infrastructure.  
**Generation direction:** principal testbed for actual productive landscapes rather than parkland: crop plots, orchards, vineyards where suitable, mills, barns/storage, irrigation, farm lanes, animal/service compounds, estate houses, labor settlements, ferry/road transfer points.

**Strong working allocation logic:** because land inside/adjacent to a megacity is exceptionally valuable, these estates should favor **high-value and intensive production** over trying to replace the enormous bulk-grain hinterland. Expect market vegetables, potatoes and roots, legumes, orchards, grapes, specialty fruits, seed plots, fodder, hemp/flax, dairy/meat support, nurseries, and processing. Some cereal acreage is appropriate, but the city should remain dependent on imported bulk grain. Low wet parcels may support rice or taro where ecology, ownership, and market demand justify it.

## Prison / Legion Headquarters complex

**Established role:** northeastern military/prison concentration connected by great bridge and military water route.  
**Generation direction:** garrison, stores, command, training, prison labor, naval/military infrastructure; more fortress-campus than ordinary district fabric.

---

# 5. Food, Cuisine, and Agriculture

## 5.1 Established food-system constraints

**ESTABLISHED CANON / STRONG WORKING MODEL**

The city is a food-dependent megacity, not a self-sufficient agricultural commune. Its local farming matters greatly for resilience, freshness, specialty products, employment, and crisis buffering, but bulk calories still depend on imports.

- Bread/grain is the crisis accounting anchor.
- The city relies on lake shipping, Heartland farms, the Colovian lease, Nibenese trade, outer estates, warehouses, and distributed granaries.
- Each district maintains granaries and emergency infrastructure; Market and Waterfront are the largest redistribution nodes.
- Fishing provides protein and employment but cannot replace staple imports at megacity scale without destroying stocks.
- Arena receives established Nibenese rice and alcohol traffic.
- House Runellius sells freshwater eel.
- Agrarian Estates are a dedicated productive landscape.
- Arboretum is primarily non-food cultivation and water management.
- Artisan participates heavily in milling, brewing, distilling, baking, storage vessels, agricultural tools, wagons, and repair.

The food generator should therefore model **production, import, storage, processing, and distribution as spatially distinct but connected systems**. A famine or shortage should be legible in the city because docks, canals, granaries, mills, warehouses, markets, estates, or protected fisheries have been disrupted.

## 5.2 Canon-compatible crop and food palette

**STRONG WORKING MODEL INFORMED BY ELDER SCROLLS IV: OBLIVION**

*Oblivion* directly supports a broad temperate-to-warm Cyrodiilic food palette. Game ingredients/foods include wheat/flour/bread, rice, potatoes, corn, carrots, leeks, lettuce, onions, pumpkins, radishes, tomatoes, grapes, apples, pears, oranges, strawberries, blackberries, watermelon, cheese, beef, mutton, ham/pork, boar, venison, crab, wine, ale/beer, and other prepared foods. Sacred lotus also exists as an ingredient. This means RUBY_WHEEL does not need to artificially restrict Cyrodiil to a narrow pseudo-medieval-European crop list.

The campaign additionally uses **taro** and **chickpeas/pulses** as setting-compatible agricultural additions from prior Arcane District planning. These are campaign extrapolations, not claims that the items appear as harvestable *Oblivion* crops.

Useful crop families for generation:

- **bulk grains/starches:** wheat and other grain-equivalents, rice, corn, potatoes;
- **wet cultivation:** rice, taro, lotus/specialty aquatic plots;
- **legumes:** chickpeas and comparable pulses;
- **market vegetables:** carrot, leek, lettuce, onion, pumpkin, radish, tomato and comparable greens;
- **orchards/fruit:** apples, pears, oranges where microclimate permits, berries, specialty fruit;
- **vine crops:** grapes and wine production, watermelon, pumpkins;
- **industrial/agricultural fibers:** hemp, flax, reeds and other rope/textile inputs already demanded by city industry;
- **alchemical/medicinal:** region-appropriate herbs plus purpose-grown magical ingredients;
- **animal foods:** cattle/beef, sheep/mutton, pigs/ham, managed hunting/venison/boar, lake fish, eel, crab and related freshwater harvests.

The generator may expand within these families when the addition is compatible with Elder Scrolls ecology and the established cultural model. It should not treat the game’s finite item list as an exhaustive botanical census.

## 5.3 Crop allocation by place

**STRONG WORKING MODEL / AI-SYNTHESIS RESPONSIBILITY**

Crop choice should emerge from water, soil, island elevation, parcel size, transport, pollution, owner culture, market demand, processing access, and current scarcity. Culture creates demand and inherited practice; it does not override agronomy.

| Area | Productive emphasis | Why |
| --- | --- | --- |
| **Arcane District** | Rice-dominant wet farming; taro; pulses/chickpeas; vegetables; orchards; alchemical/experimental plots | Canal-rich low islands, prior campaign planning, heavy Nibenese/eastern influence, University experimentation, local urban food demand |
| **Agrarian Estates** | Intensive vegetables; potatoes/roots; legumes; orchards; grapes/vineyards; selected grain; fodder; hemp/flax; animal support; nurseries | Highest dedicated food-production role; strong processing link to Artisan; valuable land favors intensive production while imports remain essential for bulk staples |
| **Nibenese District / eastern outskirts** | Rice and wet vegetables where low/wet; fruit; herbs; market gardens; fish/eel support; specialty horticulture | Strongest Nibenese consumer/merchant concentration and direct eastern trade, but still an urban district rather than continuous farmland |
| **Colovian District / western outskirts** | Wheat/grain plots where space allows; potatoes and roots; onions/leeks; orchard/vine parcels; fodder; animal yards | Strong Colovian grain/meat/ale demand and western caravan/estate connections |
| **Heartlander / mixed outer land** | Mixed wheat, vegetables, pulses, orchard plots, grapes, market gardens | Cosmopolitan baseline and flexible response to city demand |
| **Arboretum** | Reeds, algae, fiber, dyes, medicinal/alchemical plants, perfume/ritual crops, nurseries; tightly controlled edible plots only | Water-treatment and flood-buffer role; food is secondary and contamination risk matters |
| **Temple institutions** | Kitchen gardens, orchards, herbs, sacred/ritual gardens, charity allotments | Institutional feeding, ritual, medicine, relief and hospitality rather than bulk production |
| **Nobles estates** | Walled kitchen gardens, fruit courts, herbs, ornamental/ritual cultivation, prestige orchards | Household provisioning and status; not a major citywide calorie source |
| **Market / Waterfront / Arena / Industry / Legion** | Minimal primary farming; rooftop/courtyard gardens where plausible; fish pens or service gardens in suitable edges | Land value, pollution, freight, military, entertainment and industrial functions dominate; these districts obtain food through logistics |

### Arcane agricultural target

Prior campaign planning gives Arcane a particularly useful visual target: **25–35% visibly productive green land**. Within that productive land, aim strategically for **50–60% wet rice cultivation, 15–20% legumes/raised-bed staples, 10–15% vegetables/greens, 5–10% alchemical/medicinal plots, and 5–10% fruit/lotus/specialty gardens**.

These percentages are **district-level planning weights**, not parcel-by-parcel quotas. The strategic generator should distribute them according to island hydrology and urban obligations, and lower-level generation should be free to reject a crop on an unsuitable parcel and feed that feasibility result upward.

## 5.4 Cultural cuisine profiles

These are **strong working generation models**, derived from the GM’s real-world cultural analogues plus existing Elder Scrolls foods and campaign trade patterns. They are not one-to-one copies of historical national cuisines. Exact recipes are AI/procedural synthesis detail.

### Heartlander cuisine — metropolitan Roman/Imperial substrate

**Identity:** broad urban Imperial cuisine shared across classes and modified by imports.

- **Staples:** wheat bread, grain porridge/gruel, pulses, vegetables, potatoes increasingly common where cheap.
- **Proteins:** cheese, lake fish/crab, pork/ham, mutton, beef at higher cost, occasional game.
- **Produce:** onions, leeks, lettuce, carrots, radishes, tomatoes, pumpkins, orchard fruit, grapes.
- **Methods:** bread ovens, stews, braises, grilling, roasting, porridges, filled breads/pies, herb sauces, preserved fish/meat, pickles.
- **Drinks:** wine is culturally central; ale/beer common among workers and mixed households.
- **Urban expression:** bakeries, thermopolium-like hot-food counters, taverns, bathhouse food service, market stalls, institutional kitchens.

Heartlander is the city’s **shared culinary grammar** in the same way Heartlander/Imperial masonry is its shared civic architectural grammar. Other cultures layer onto it rather than replacing it completely.

### Colovian cuisine — Germano-Roman, durable and preservation-heavy

**Identity:** practical, filling, grain/root/meat oriented, with stronger preservation traditions and a martial/caravan culture.

- **Staples:** coarse and fine breads, grain porridges, potatoes and other roots, onions/leeks, pulses.
- **Proteins:** pork/ham, mutton, beef, cheese, game where available.
- **Methods:** thick stews, roasts, sausages or forcemeat-like preparations, smoking, salting, pickling, baking, preserved travel rations.
- **Drinks:** ale/beer important; wine remains common, especially among elites and in cosmopolitan households.
- **Urban expression:** veterans’ halls, beer/ale houses, bakeries, butcher/smokehouse clusters, caravan inns, military ration kitchens.

Colovian cuisine should feel capable of feeding soldiers, travelers, miners and estates efficiently without reducing elite Colovian food to peasant fare. Wealth changes ingredients and presentation more than the underlying preferences.

### Nibenese cuisine — Hellenic river-urban base with Akaviri inheritance

**Identity:** urban, riverine, mercantile, aromatic, varied, with both rice and wheat traditions and strong access to imported ingredients.

- **Staples:** rice, wheat breads/flatbreads, pulses, vegetables, taro in wet-growing communities.
- **Proteins:** lake fish, eel, crab, pork, mutton, poultry/small livestock where available, cheese in mixed/Heartlander-influenced households.
- **Produce:** leafy greens, onions/leeks, tomatoes, fruit, grapes, melons, herbs, lotus/specialty wet-garden produce.
- **Methods:** grilling, broths/stews, rice dishes, filled breads, skewers, pickling/fermentation, preserved fish, small shared dishes, herb- and spice-forward sauces.
- **Drinks:** wine and established eastern/Nibenese alcohol; rice-based alcohol is a natural campaign fit where rice culture is strong.
- **Urban expression:** rice sellers, fish/eel stalls, merchant-house dining courts, garden restaurants, tea/infusion or drinking houses where later asset/lore work supports them, festival vendors, high-end patronage cuisine.

Nibenese cuisine should vary sharply by class: an Industry laborer, Arena bookmaker and Nobles-district Nibenese house share culinary ancestry but not the same ingredients, service or presentation.

### Akaviri cuisine — inherited eastern household tradition

**Identity:** a strong but historically layered tradition surviving both in Akaviri-descended families and in Nibenese metropolitan cuisine.

- **Staples:** rice and rice-derived preparations; vegetables; broths; noodles/dumpling-like forms may be used if later asset/lore work supports them.
- **Proteins:** fish/eel, pork and other meats in smaller or carefully portioned dishes, preserved proteins.
- **Methods:** grilling, steaming/boiling, broth cookery, pickling/fermentation, careful seasonal presentation, portable rice/grain foods for martial or travel contexts.
- **Drinks:** rice alcohol and other eastern ferments where supported by the local economy.
- **Household expression:** inherited family dishes, shrine offerings, memorial foods, festival foods, swordsman-school or household-retainer meals.

Do not generate “Akaviri food” as a completely separate restaurant category everywhere. Centuries of intermarriage mean many techniques and dishes should appear naturally inside Nibenese and mixed Imperial households.

## 5.5 Culture, class, district and scarcity interact

**CORE GENERATION RULE**

Cuisine should be generated from several orthogonal axes:

```text
cultural cuisine profile
+ household wealth/class
+ district market access
+ season
+ religion / institutional rules
+ current scarcity and price state
+ available local/imported ingredients
= meals, vendors, restaurants, household stores, and food businesses
```

A Nibenese noble in Nobles and a Nibenese laborer in Industry may both prefer rice, fish, fermented vegetables and eastern alcohol, but the noble household consumes fresher fish, rarer fruit, better wine/alcohol, imported spices and elaborate service while the laborer relies on cheap rice, pulses, preserved fish, vegetables and street food.

Likewise, district cuisine is not a cultural monoculture. Market should contain foods from everywhere because that is its economic role. Temple cuisine reflects pilgrimage, charity and ritual. Arena cuisine should be dense with fast prepared food and alcohol. Legion food should include standardized mass feeding and ration infrastructure.

## 5.6 Agriculture should respond to crisis

**AI / PROCEDURAL SYNTHESIS RESPONSIBILITY**

World state should alter both food logistics and visible land use without requiring a full calorie simulator in the first implementation. Examples:

- high grain prices increase pressure to plant marginal suitable parcels;
- disrupted Nibenese trade increases the price/status of rice and eastern alcohol;
- a blocked Waterfront shifts more traffic to smaller district ports and local reserves;
- contaminated channels suppress edible cultivation and increase reliance on imported vegetables;
- protected granaries, mills, fisheries and estate docks become political/military objectives;
- noble or temple gardens may be converted partly to subsistence/relief use during severe shortages;
- black-market fishing and poaching increase when formal quotas fail.

The city should visibly tell the story of its food security state.

---

# 6. Power and Institutional Layers

**ESTABLISHED CANON / CURRENT CAMPAIGN BASELINE**

City generation should be able to place or reserve physical expression for:

- Lord Protector Caius Lex and central government;
- Elder Council blocs;
- district mayors and councils;
- Imperial Cult institutions;
- Mages’ Guild / Arcane University;
- minor and major noble houses;
- merchant/banking houses;
- shipping magnates;
- guilds and master craftsmen;
- district guards, Legion and Navy;
- logistics-linked gangs and fixers;
- active player houses such as Krotolous and Runellius.

Minor houses are not decorative surnames: they can own docks, workshops, farms, restaurants, warehouses, licenses, temples, schools, debt and armed retainers. Therefore a “house compound” generator should support economic attachments and satellite properties rather than assuming one mansion equals one house.

---

# 7. Procedural 3D Building Model

## 7.1 Do not generate culture as a single mesh style

**PROPOSED GENERATION ARCHITECTURE**

A building should result from a composition such as:

```text
site geometry
+ functional archetype
+ district morphology
+ primary cultural vocabulary
+ secondary cultural influences
+ wealth / quality
+ age / historical layer
+ waterfront / street / courtyard context
+ current world-state modifiers
+ deterministic seed
= generated building/compound
```

Example:

```text
Nobles District lot
+ urban_villa_compound
+ elite_low_density morphology
+ primary Nibenese vocabulary
+ secondary Akaviri vocabulary
+ wealthy
+ Potentate-era core with post-pogrom alterations
+ canal frontage
+ seed
```

## 7.2 Shape grammar layers

**AI / PROCEDURAL SYNTHESIS RESPONSIBILITY**

Each cultural palette should ultimately provide weighted choices for:

- footprint organization: row, courtyard, compound, hall-and-yard, perimeter block, pavilion cluster;
- massing: width/depth/floor ranges, wings, towers, annexes;
- roof families;
- façade bay rhythm;
- openings and balconies/galleries;
- arcades/colonnades/verandas;
- courtyard/garden treatment;
- walls/gates;
- street setback/frontage;
- waterfront interface;
- materials/colors;
- civic/religious/household ornament;
- service buildings;
- defensive/security expression.

The generator should select from these grammars deterministically rather than asking an AI to invent every individual mesh.

The AI/software work is to create and tune the reusable grammar and component kit — not to improvise an unrelated bespoke building every time. Early kits may be procedural geometry assembled from simple parametric pieces; higher-quality authored or AI-assisted assets can replace individual components later without changing the semantic building grammar.

## 7.3 District and culture are orthogonal axes

This is essential.

The Nobles District profile controls things like prestige, surveillance, larger lots, gardens, servant/service infrastructure and lower industrial intensity. It does **not** say “all buildings are Colovian.”

Likewise, Arena may be strongly Nibenese-influenced but still contain Heartlander blocks, surviving Akaviri compounds, foreign inns, Imperial civic buildings and ordinary mixed housing.

This permits culturally heterogeneous islands and neighborhoods without losing district identity.

---

# 8. From Human Bible to Machine Profiles

Do not make this Markdown the runtime generator input forever. The recommended pipeline is:

```text
Human-reviewed generation bible
        ↓
Machine-readable culture profiles
        +
Machine-readable district profiles
        +
Building archetype registry
        +
Food/agriculture profiles
        ↓
Strategic city/district/island allocation
        ↓
Deterministic geometry generator
```

The conversion from this human bible into those machine profiles is itself an **AI / procedural synthesis task**. The generated profiles should be reviewable, versioned, testable and revisable; the GM should not need to manually populate hundreds of weights.

Potential machine-readable concepts later:

```text
CultureProfile
  id
  massing_weights
  roof_weights
  courtyard_weights
  facade_components
  material_palette
  garden_gate_components
  religious_components
  cuisine_profile_id

DistrictProfile
  density
  height_distribution
  land_use_weights
  wealth_distribution
  street_character
  market_hierarchy
  waterfront_behavior
  pollution
  security
  culture_presence_weights   # population tendency, not a hard restriction

BuildingArchetype
  functional_role
  lot_requirements
  footprint_grammar
  service_requirements
  compatible_cultural_components

HouseholdProfile
  heritage
  wealth
  religion
  political/economic role
  preferred culture palette mix
  security / compound needs
```

---

# 9. Readiness and Responsibility

## GM-accepted must-exist hard anchors

The following features must exist in the canonical generated city and must be represented as protected hard anchors or protected infrastructure before ordinary procedural generation is allowed to replace surrounding fabric:

- the two established player compounds, preserving their already-established locations, extents, and campaign identity;
- White-Gold Tower and the Imperial Palace / central palace precinct;
- the Temple of the One;
- the Arcane University;
- the Imperial City Prison;
- the Waterfront mega-docks / principal large-ship harbor complex;
- the Mages’ Guild satellite certification office in the Artisan District;
- the Arena;
- the Arboretum water-treatment and flood-management networks as a functional infrastructure system, not merely a decorative landmark.

These anchors do not require all surrounding geometry to be hand-authored. Their identity, required presence, and established spatial/functional relationships are protected; ordinary adjacent urban fabric may still be synthesized. Additional hard anchors may be promoted later from campaign play or accepted source interpretation without requiring the entire city to be manually inventoried first.

## Strongly established now

- district functions and economic roles;
- citywide water/logistics/food infrastructure;
- market hierarchy and physical finance;
- vertical density model;
- canal/bridge/wall movement logic;
- east/west economic pattern with cultural cross-currents;
- political/institutional actors;
- hard/soft/ordinary canon distinction;
- cultural mixing as a campaign fact;
- several active houses and their heritage/economic roles;
- broad Heartlander, Colovian, Nibenese and Akaviri visual direction;
- broad cultural cuisine direction;
- Arcane agriculture strategic mix;
- Agrarian Estates as the main dedicated intensive food-production landscape;
- the principle that district, culture, class, function, history and environment are separate generation axes.

## Strong working models suitable for procedural translation

- culture-specific architectural vocabularies;
- component-based rather than averaged cultural mixing;
- cuisine profiles and class/district interaction;
- crop-location logic;
- construction-era/history layering;
- food-system response to scarcity and disruption;
- differentiated outer-district roles.

These are not meant to be exhaustively hand-authored by the GM. They are enough direction for an AI/algorithm to produce a first machine-readable profile, generate bounded samples, and iterate when outputs look wrong.

## AI / procedural synthesis responsibilities

The following are **implementation work, not missing GM worldbuilding**:

- exact culture-presence and culture-mixing weights by district/island/block;
- exact façade/material/roof/courtyard/gate parameter sets;
- reusable 3D cultural component kits;
- household/property allocation below explicitly authored houses and institutions;
- ordinary named or unnamed businesses and neighborhood services;
- crop selection on individual parcels and field geometry;
- detailed menus, recipes, vendors, restaurants and food businesses;
- construction-era distributions and renovation histories for ordinary buildings;
- ordinary POI generation and promotion candidates;
- district mayor/faction/property maps where not already fixed by campaign play;
- outer-district detail below the established strategic role.

The expected workflow is **derive → generate a bounded sample → inspect → revise the profile**, not “ask the GM to specify every parameter first.”

## Genuine open questions to surface only when consequential

- unresolved named canon involving major houses, mayors, strategic institutions or active campaign plots;
- any future contradiction between the current 6,744 m city geometry and older campaign measurements;
- hard-anchor placement when source material is genuinely ambiguous;
- decisions that would materially change campaign politics, sacred geography, player-established property or protected infrastructure.

Ordinary uncertainty should be synthesized rather than escalated.

---

# 10. Source Basis

Primary sources used for this specification:

- `docs/REQUIREMENTS.md` and `docs/ARCHITECTURE.md` — current RUBY_WHEEL generation/scale/canon contracts.
- *Imperial City Interregnum Campaign Bible* — especially Parts 3–7 and 9: geography/movement, district guide, urban systems, food/trade/infrastructure, political institutions, Arcane District, active houses.
- *Imperial City Session 0 Playbook* — house heritage and district quick-reference categories.
- *Breaking the Interregnum: Cyrodiil* — older district descriptions, Akaviri/Nibenese context and campaign geography; use cautiously where later sources differ.
- *House Krotolous Briefing* and *House Runellius Briefing* — active household/cultural examples.
- Imperial City price references/workbooks — crisis food/economic anchors.
- Prior UESRPG Campaigns agriculture planning (20 July 2026) — Arcane District productive-green-land target and rice/taro/chickpea/orchard mix.
- *The Elder Scrolls IV: Oblivion* food/ingredient references (cross-checked through UESP and other reference indexes) — canon-compatible crop and food palette including rice, potatoes, corn, wheat/flour/bread, common vegetables, grapes/fruit, meats, cheese, wine and ale.

External game references establish that a food/crop exists in Cyrodiil/TES; they do **not** by themselves establish this campaign’s exact cultivation geography. Placement and prevalence remain derived from campaign climate, hydrology, economics, cultural demand and prior campaign decisions.

