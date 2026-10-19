# Naming decision: **Smaltic**

Date: 2026-10-19. Status: decided, with launch prerequisites (see §5).

## 1. Decision

The product is named **Smaltic** (pronounced *SMAL-tik*, rhymes with "Baltic").

- Etymology: *Smalti* / *smalto* (Italian) are the hand-cut glass tesserae of mosaics. *Smalt* is a cobalt glass (EN/DE). Romanian has *smalț* and Russian has *смальта* (mosaic glass). *Smaltic* means "made of mosaic pieces". A mosaic is many small pieces composed into one picture, and a Smaltic page is many slices composed into one page.
- **Family.** `npx create-smaltic`, `smaltic dev`, `@smaltic/client`, `SMALTIC_API_URL`, `docker run smaltic/smaltic`, smaltic.dev, Smaltic Studio, Smaltic Cloud.

## 2. Why the previous name was dropped

"Refract" was taken. **refract-cms** is an existing "Code-first Headless CMS using TypeScript/React/GraphQL" on GitHub, the npm name `refract` is taken, and refract.io is in use.

## 3. Namespace verification for Smaltic (2026-10-19)

| Namespace | Result |
|---|---|
| npm `smaltic`, `create-smaltic`, org `@smaltic` | free (registry 404) |
| PyPI, crates.io, Docker Hub user | free |
| GitHub user/org `smaltic` | free; 2 tiny unrelated repos contain the string |
| Apple App Store (iTunes Search API) | no app |
| Domains .com .dev .io .app .org .net .ai .co .sh | all unregistered (DNS + Verisign RDAP for .com) |
| Web search | no product or company. Only the craft terms smalt, smalti and smaltite appear |

## 4. Process and evidence

1. **Mechanical screening of about 130 hand-made candidates and 420 generated coinages.** Checks covered npm (exact name, `create-`, scope), GitHub, PyPI, Docker Hub, App Store, 5 to 10 TLDs and web search. Candidates were drawn from glass and light vocabulary, mosaic, inlay, weaving, joinery, Japanese crafts and Moldovan heritage words.
2. **Adversarial multi-model debate** (`debate` skill, 7 rounds). The challengers were a brand-architecture strategist (Gemini via agy), a developer-experience lead (Codex) and a trademark attorney and comparative linguist (Mistral via vibe). Every factual claim a challenger made was re-verified. The challengers produced several invented trademark registration numbers, which were discarded.
3. **How the main finalists were eliminated:**

| Candidate | Fatal finding (verified) |
|---|---|
| Vitralia (and the whole `vitr-` family) | Crowded with software marks: VITRANET trademark application (2024, software), Vitrace, Vitruvi, Vitre, Vitrine, Vitralogy, OpenStack Vitrage. Also 4 syllables and ambiguous spelling |
| Dichroa | Fails the "spell it after hearing it once" test |
| Fritwork | *frit/frito/fritto* means "fried" in FR/ES/PT/IT, *fript* means "roasted" in RO, and it is easily misheard as "fretwork" |
| Quiltry | An iOS app called "Quiltry: Quilting Calculator" (2026) exists, confirmed through the iTunes lookup API |
| Inlaio | Close to InlayAI (developer SDK and CLI) and the old self-hosted "Inlay CMS" |
| Weftwork | Weftworks (a UK SaaS venture studio) and a WeftWork YouTube channel exist |
| Yosegi | Yahoo Japan's "Yosegi" storage format, and the `@yosegi` npm scope is in use |
| Intarza | Sounds like Romanian *întârzia*, "to be late" |
| Covor | The `cov-` prefix reads as code coverage (Codecov, `--cov`), it is close to COVORO (a SaaS), and Russian *вызвать на ковёр* means "to be called in for a reprimand" |
| Velto, Ferva | Velto is an existing JS framework (`create-velto`, Vite plugin) and Ferva Health is an app |
| Tessera, Tessel, Lucet, Lumora, Kaleido, Opalis, Fenestra, Tessellio, Pagelume, Facettio | Already taken, or carrying negative associations (see the debate log) |

4. **Main objection to Smaltic and how it was resolved.** The concern was similarity to PRISMIC: both end in "-ic" and both come from glass. The rebuttal is that **Plasmic** (plasmic.app) has coexisted with Prismic since 2021 in the same visual-builder market. Its GitHub repo `plasmicapp/plasmic` was created 2021-02-02 and has about 7.1k stars. PLASMIC and PRISMIC are much closer to each other than SMALTIC is to either: SMALTIC shares neither the initial consonant cluster nor the root, only the generic "-ic" suffix. After the rebuttal, all three challengers accepted Smaltic with minor objections only.

## 5. Launch prerequisites and mitigations

- [ ] **Formal trademark clearance** (EUIPO/TMview, WIPO Global Brand Database, USPTO; Nice classes 9 and 42) before any public launch. Namespace availability is not clearance.
- [ ] Register the domains you want (suggested: smaltic.dev and smaltic.com) and the GitHub org `smaltic`. **This is the owner's decision. Nothing has been registered yet.**
- [ ] Reserve the defensive npm name `smalltic` (common misspelling), redirecting to `smaltic`.
- [ ] Use "Prismic" only as a reference ("compatible with the Prismic APIs"), never in the product name, logo, domain or package names. Show an "independent project, not affiliated with Prismic" notice.
- [ ] Lead the brand story with mosaic composition, not optics.

Known minor risks that were accepted: the misspelling "smalltic"; RO *smalț* and IT *smalto* (enamel, a neutral craft meaning); and NL/SV *smal* ("narrow"), which is a different word.
