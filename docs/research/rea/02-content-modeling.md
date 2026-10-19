# REA 02: Content modeling (types, fields, slices, builders)

Scope: how Prismic models content (page types, custom types, tabs, fields, slices, variations), the model JSON,
the Content API value of every field type (filled and empty), editor behaviour the docs describe for each field,
the three modeling tools (Type Builder, Slice Machine, Legacy Builder) and the documented limits.
Out of scope (other REA docs): query API semantics, editor/admin UI in general, SDK internals.

## Citation conventions

- `pages/<file>.md § <heading>`: official docs mirror at `docs/research/prismic-docs-mirror/pages/` (fetched 2026-10-19).
- `ev/<file>`: live production captures in `docs/research/evidence/` (repo `prismic-main`, 105 distinct documents,
  1,983 slices, ~2,300 links scanned by script for this report).
- `ti/src/...`: `@prismicio/types-internal` 4.8.0 source (the zod schemas Prismic's own tools use to validate models),
  read-only copy under the session scratchpad `sdk/node_modules/`; same convention as `docs/research/api-contracts.md`.
- **[DISCREPANCY]** marks a conflict between docs, SDK schemas and live evidence. **[INFERENCE]** marks a conclusion
  not literally stated anywhere.

Requirement tags: P0 = needed for wire compatibility with existing SDKs/content; P1 = needed for parity of the modeling
workflow; P2 = nice to have / legacy.

---

## 1. Type model

### 1.1 Concepts

- The four modeling structures are "fields, page types, slices, and custom types" (`pages/content-modeling.md § What is content modeling?`).
- Page type: "represent the pages in your website"; "designed around slices"; "includes search engine optimization (SEO) and
  unique identifier (UID) fields by default" (`pages/content-modeling.md § Page types`).
- Custom type: "represent content that isn't a page", e.g. settings, menus, categories (`pages/content-modeling.md § Custom types`).
  Slices "are intended for page types and should be avoided in custom types" but can be enabled with a toggle
  (`pages/content-modeling.md § How to create a custom type`).
- Page type vs custom type is a single model property, `format: "page" | "custom"`, default `"custom"`
  (`ti/src/model/customType.ts:14,30`). CLI: `npx prismic type create "Page" --format page`; "Custom is the default format"
  (`pages/content-modeling.md § How to create a custom type`). The Content API does not expose `format`; both are "documents"
  (the glossary calls every instance a "page": `pages/glossary.md § page`).
- Reusable (repeatable) vs Single: "Reusable type: There is no limit to how many pages of this type can be published";
  "Single type: Only one page of this type can be published" (`pages/content-modeling.md § How to create a page type`).
  Model property `repeatable` (default `true`, `ti/src/model/customType.ts:27`). Singles are fetched with `getSingle()`,
  reusables with `getByUID()` (`pages/content-modeling.md § Recommended models`).
- Static zone / slice zone: "Page types are composed of a static zone and a slice zone, which are composed of fields and
  slices, respectively" (`pages/glossary.md § content modeling`). Static zone fields "appear at the top of a page in the Page Builder"
  (`pages/content-modeling.md § How to create a page type`). Glossary: "A container for immovable and non-repeatable fields"
  (`pages/glossary.md § Static Zone`).
- Tabs: the model `json` is `Record<tabName, Record<fieldId, field>>`. Tab keys are display names ("Key should be display
  name of the tab, e.g. "Main"", `pages/legacy-builder.md § Custom type JSON structure`). Tabs are a pure editor grouping:
  the API flattens every tab into a single `data` object (`ti/src/helpers/customTypeModel.ts` `flatten()`), therefore field IDs
  must be unique across tabs ("`${widgetID} already exists in the "${maybeTabID}" tab`", `ti/src/model/customType.ts:59-66`).
  The Type Builder / CLI docs never mention tabs; they survive in model JSON only.

### 1.2 Model JSON envelope (custom type / page type)

Schema (`ti/src/model/customType.ts:24-38`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | API ID, used as `document.type`. Cannot be changed after creation (`pages/legacy-builder.md § Change a Custom Type API ID`). |
| `label` | string \| null | - | Display name in the Page Builder; also the value in the Repository API `types` map (`ev/api-root.prismic-main.json`: `"blog_author": "Blog Author"`). |
| `repeatable` | boolean | `true` | Reusable (true) vs Single (false). |
| `json` | `{ [tab]: { [fieldId]: FieldModel } }` | required | Tabs and fields. |
| `status` | boolean | `true` | Active (`true`) or disabled (`false`) (`pages/custom-types-api.md § Custom types status`). |
| `format` | `"page" \| "custom"` | `"custom"` | Page type vs custom type. |
| `schema` | `"@prismicio/types-internal@4.5.0"` (optional) | absent | Opt-in stricter validation (UID id must be `uid`, unique field IDs across tabs). |

Example copied from the docs (`pages/custom-types-api.md § Active custom types`):

```json
{
  "id":"page",
  "label":"Page",
  "repeatable":true,
  "json":{
    "Page":{
      "uid":{
        "type":"UID",
        "config":{
          "label":"UID",
          "placeholder":"example-unique-identifier"
        }
      }
    }
  },
  "status":true
}
```

Legacy Builder example with two tabs, a number field, a slice zone with a legacy composite slice and a color field
(`pages/legacy-builder.md § Custom type JSON structure`):

```json
{
  "Example First Tab": {
    "example_number": {
      "type": "Number",
      "config": { "label": "Example Number", "placeholder": "3.14159..." }
    },
    "body": {
      "type": "Slices",
      "fieldset": "Slice zone",
      "config": {
        "labels": { "example_first_slice": [] },
        "choices": {
          "example_first_slice": {
            "type": "Slice",
            "fieldset": "Example First Slice",
            "description": "This is the first example slice.",
            "icon": "adb",
            "display": "list",
            "non-repeat": {
              "example_slice_key_text": {
                "type": "Text",
                "config": { "label": "Example Slice Key Text", "placeholder": "Massa sapien faucibus..." }
              }
            },
            "repeat": {}
          }
        }
      }
    }
  },
  "Example Second Tab": {
    "example_color": { "type": "Color", "config": { "label": "Example Color" } }
  }
}
```

(The Legacy Builder JSON editor shows only the `json` part; the envelope is added by the Types API.)

A modern page type (Type Builder / CLI) references shared slices by ID only: `choices: { "<slice_id>": { "type": "SharedSlice" } }`
(`ti/src/model/slice.ts:119-121`, `toDynamic()` in `ti/src/helpers/customTypeModel.ts`). The "SEO" fields added by default to page types
are not specified in the docs **[INFERENCE: Slice Machine historically created an "SEO & Metadata" tab with `meta_title` (Text),
`meta_description` (Text), `meta_image` (Image); not verifiable from the mirror]**.

### 1.3 Where models live and file layout

- Type Builder: "Changes made in the Type Builder are saved directly to your Prismic repository" (`pages/type-builder.md § Features`);
  `npx prismic pull` writes them into the project; "Prismic's models are the source of truth, so your local files are created,
  updated, or deleted to match" (`pages/cli.md § Pull models from Prismic`). `npx prismic push`: "Your local files are the source of
  truth" (`pages/cli.md § Push models to Prismic`).
- Files: page/custom types `customtypes/<id>/index.json`; slices `src/slices/<Name>/model.json` (`pages/fields/rich-text.md § Use labels
  for custom formatting`, `pages/slice-machine.md § Model files`). prismic-ts-codegen globs `./customtypes/**/index.json`,
  `./slices/**/model.json` (`pages/technical-reference/prismic-ts-codegen/v1.md § Configure your model locations`).
- Routes per page type live in `prismic.config.json` `routes[]`; "The Prismic CLI adds a default route for each page type"
  (`pages/routes.md § Define route resolvers`).

### 1.4 Lifecycle of model changes

- "Adding a field: The new field appears with an empty default value. Removing a field: The field no longer appears. Renaming a field:
  If the API ID is changed, existing content is not transferred" (`pages/content-modeling.md § Impact of pushing changes`).
- Removed field data is not destroyed: "You can recover data in a field that has been removed from a custom type ... Add the old field
  back ... Use the same field type and API ID" (`pages/legacy-builder.md § Recover lost data`). Storage must keep data for fields
  absent from the current model.
- "The Content API will not reflect the content model changes until at least one page is published or archived"
  (`pages/content-modeling.md § Impact of pushing changes`): the API projects stored content through the model of the current ref.
- Changing a slice API ID drops its content ("all the existing content you have for that slice will disappear",
  `pages/legacy-builder.md § Change the API ID of a slice`).
- Disabling a type (`status:false`): "you won't be able to create any more pages of this type. All previously created pages will remain"
  (`pages/legacy-builder.md § Disable custom types`). Deleting requires deleting all its pages, then disabling, then delete; a deleted ID
  may still be refused ("Type ID already used", `pages/legacy-builder.md § Delete`). Deleted models are recoverable at
  `https://<repo>.prismic.io/masks/<id>.json/` (`pages/legacy-builder.md § Recover deleted custom types`).
- Default values are applied when reading/writing content: Boolean `default_value` and Select `default_value` are injected for
  missing content; groups get item defaults (`ti/src/helpers/withDefaultContent.ts` `widget()`, `items()`).

---

## 2. Field types

### 2.0 Common rules

- Glossary: "Prismic has 18 different field types": 8 simple (UID, boolean, color, date, timestamp, number, text, select) that "return a
  primitive value", and 10 structured (rich text, image, content relationship, link, link to media, embed, geopoint, repeatable group,
  table, integration) that "return an object value" (`pages/glossary.md § field`).
- Model `type` strings accepted (`ti/src/model/widget.ts:30-51`): `Color, Boolean, Number, Embed, GeoPoint, Date, Range, StructuredText,
  Select, Separator, Table, Text, Timestamp, Link, Image, IntegrationFields, UID, Group, Slices, Choice`, plus slice types `Slice`,
  `SharedSlice`. `Range`, `Separator`, `Choice` are legacy and undocumented in the mirror.
- Mapping of documented fields to model types: Content relationship and Link to media are **not** separate types; they are `Link` with
  `config.select = "document"` / `"media"` (CLI: "A link to media field is a link field restricted to media. Use ... `--allow media`",
  `pages/fields/link-to-media.md § Add a link to media field to a content model`).
- Every field model is `{ "type": <T>, "fieldset"?: string|null, "config"?: {...} }`. Every config accepts `label` (string|null,
  "The label shown to content writers"); most accept `placeholder` (string). API ID = the object key: "The property name in the Content API.
  Use a short, snake-cased name" (every `pages/fields/*.md § Add ...`). Field keys must not contain `<` or `>`
  (`ti/src/common/widgetKey.ts:3`).
- `useAsTitle` (boolean) exists on `Text`, `Embed`, `Link`, `UID`, `StructuredText` configs (`ti/src/model/*.ts`); undocumented
  **[INFERENCE: marks the field used as the document title in editor lists]**.
- Empty-value semantics are fixed per type (see each section and the summary table 2.19). `isFilled.*` helpers in `@prismicio/client`
  define "empty" for SDK users (`pages/technical-reference/prismicio-client/v7.md § isFilled`; detail in `api-contracts.md § 1.14`).

### 2.1 Boolean

- Purpose: "select a `true` or `false` value ... displayed as a toggle" (`pages/fields/boolean.md`).
- Model: `{"type":"Boolean","config":{"label","default_value"?: boolean,"placeholder_true"?: string,"placeholder_false"?: string}}`
  (`ti/src/model/boolean.ts`). Booleans have no `fieldset`/`placeholder`.
- Editor: "By default, a boolean is set to `false`. It can default to `true` by checking the Default to true checkbox"; "True Placeholder /
  False Placeholder" are custom labels; "Custom labels only change the text shown in the Page Builder. The API will always return `true` or
  `false`" (`pages/fields/boolean.md § Add a boolean to a content model`). CLI: `--default-value`, `--true-label`, `--false-label`.
- API filled: `"example_boolean": true` (`pages/fields/boolean.md § API response`). Empty: never null; `false` unless `default_value:true`
  is set. Live: 990 boolean values, no nulls among booleans (`ev/search.*.json`, e.g. `"full_width": true`). Migration API: "If the field
  has a default value configured, the default value will be used for null values" (`pages/migration-api-technical-reference.md § Boolean`).

### 2.2 Color

- Purpose: "a color picker"; "saved as a hex value, like `#FFFFFF`" (`pages/fields/color.md`).
- Model: `{"type":"Color","config":{"label","placeholder"}}` (`ti/src/model/color.ts`).
- API filled `"example_color": "#5B295F"`; empty `null` (`pages/fields/color.md § API response`; `api-contracts.md § 2`).
- Validation: hex `^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$` (`ti/src/common/hexaColorCode.ts:3`); Migration API "must be a hexadecimal color value".

### 2.3 Date

- Purpose: "a date that represents a calendar day"; "saved in `YYYY-MM-DD` format"; editor display follows browser locale
  ("American English ... `MM-DD-YYYY` ... French ... `DD-MM-YYYY`") (`pages/fields/date.md`).
- Model: `{"type":"Date","config":{"label","placeholder","default"?: string}}` (`ti/src/model/date.ts`); `default` undocumented.
- API filled `"example_date": "2030-01-31"`; empty `null`. Live: 73 date values, all `YYYY-MM-DD` (fields `date`, `updated_date`), and
  `"updated_date": null` (`ev/field-shapes.observed.md § NoneType`).

### 2.4 Timestamp

- Purpose: date and time; "saved in `YYYY-MM-DDTHH:MM:SS+0000` format ... always UTC (`+0` offset)" (`pages/fields/timestamp.md`).
- Model: `{"type":"Timestamp","config":{"label","placeholder","default"?: string}}`.
- API filled: docs sample `"example_timestamp": "2030-01-31:05:00:00+0000"` **[DISCREPANCY: the sample lacks the `T`; the prose and the
  Migration API (`... § Timestamp`) say `YYYY-MM-DDTHH:MM:SS+0000`; `asDate` parses 24-char `...+0000` strings]**. Empty `null`.
  No timestamp field was present in the live sample (only document-level `first_publication_date` in the same format).

### 2.5 Number

- Purpose: "an integer (e.g. `3`) or a float (e.g. `3.14`)" (`pages/fields/number.md`).
- Model: `{"type":"Number","config":{"label","placeholder","min"?,"max"?,"step"?}}`; `min/max/step` accept numbers or numeric strings
  (`ti/src/model/number.ts`). CLI `--min 0 --max 5 --step 0.5` (`pages/fields/number.md § Add a number field`). Legacy: "Adding min and max
  values to a number field" required the JSON editor (`pages/legacy-builder.md § Add extra configuration to a field`).
- API filled `3.14`, empty `null`. Migration API: "Value must conform to `max` and `min` if either is defined" (`... § Number`).
  `step` enforcement on write is undocumented.
- `Range` (legacy) has the same config shape (`ti/src/model/range.ts`).

### 2.6 Text (Key text)

- Purpose: "plain text" without formatting (`pages/fields/text.md`). SDK name "key text" (`isFilled.keyText`).
- Model: `{"type":"Text","config":{"label","placeholder","useAsTitle"?}}`.
- API filled `"example_text": "Lorem ipsum"`; empty `null` (live: e.g. `"eyebrow": null`, `ev/field-shapes.observed.md`). SDK treats `""`
  as empty too.

### 2.7 Select

- Purpose: "choose an option from a list of text options" (`pages/fields/select.md`).
- Model: `{"type":"Select","config":{"label","placeholder","options": string[],"default_value"?: string}}`; options given as numbers or
  booleans are coerced to strings (`ti/src/model/select.ts`).
- Editor: "Use first value as default: Whether the first option is selected by default. If unchecked, content writers can leave the field
  empty" (`pages/fields/select.md § Add a select field`). CLI `--option X` repeated, `--default-value Medium`.
- API filled `"example_select": "My selected value"`; empty `null` (live `"theme": null`). Migration API: string "must match one of the
  options"; default used for null values (`... § Select`). Values are case-sensitive as written (live has both `"Purple"` and `"purple"`
  in different fields).

### 2.8 UID

- Purpose: unique identifier "often used to build page URLs" (`pages/fields/uid.md`).
- Rules (`pages/fields/uid.md`): "Only one UID field per page type or custom type is allowed. Slices cannot contain UID fields"; "unique to
  the page type or custom type and locale"; "must be lowercase and cannot contain spaces"; "cannot contain special characters, except hyphens
  (`-`) and underscores (`_`)"; "When a UID value is changed, the old value is retained as a reference. The page can be queried using the
  previous UID until another page reuses it".
- "Reusable page types and custom types include a UID field with the API ID `uid`. The UID field cannot be manually added or removed"
  (`pages/fields/uid.md § Add a UID field`). Schema 4.5.0: "The UID widget ID must be set to "uid"" (`ti/src/model/customType.ts:51-56`).
  Singles have no UID (live: some Document links lack `uid`, `ev/search.*.json`).
- Editor: "The field will populate automatically using the page's content if the field is left empty" (`pages/page-fields.md § UID field`).
- Model `{"type":"UID","config":{"label","placeholder","useAsTitle"?}}`.
- API: top-level `document.uid`, "not a property within `data`"; `slugs` "is deprecated" (`pages/fields/uid.md § API response`). Empty:
  `uid: null` **[INFERENCE: SDK type `uid: string | null`]**.

### 2.9 Rich text (StructuredText)

- Purpose: "formatted content, including paragraphs, headings, lists, and more" (`pages/fields/rich-text.md`).
- Model (`ti/src/model/richText.ts`): `{"type":"StructuredText","config":{"label","placeholder","useAsTitle"?,"single"?: string,
  "multi"?: string,"imageConstraint"?: {width,height},"labels"?: string[],"allowTargetBlank"?: boolean}}`.
  - `multi`: comma-separated allowed node types; field may hold many blocks. `single`: same list but only one block ("Allow multiple
    paragraphs" unchecked; CLI `--single`). A field with `single` is the SDK "Title" type (`isFilled.title`).
  - Allowed tokens: "`heading1` ... `heading6`, `paragraph`, `strong`, `em`, `preformatted`, `hyperlink`, `image`, `embed`, `list-item`,
    `o-list-item`, and `rtl`" (`pages/fields/rich-text.md § Add a rich text field`). Unknown tokens are dropped; empty/null list
    normalizes to `"paragraph"` (`ti/src/model/richText.ts` `RichTextOptionsSchema`).
  - Default: "By default, rich text fields support all formatting options"; restrict under **Accept** (`... step 2`).
  - `allowTargetBlank`: "Whether content writers can configure links to open in a new window".
  - `labels`: custom inline formatting; "Unlike other rich text options, labels cannot be configured in the Type Builder ... must be added by
    editing your content model's JSON file" (`pages/fields/rich-text.md § Use labels for custom formatting`). Accepted legacy forms: string,
    `null`, or `{ "": [{name}] }` object, normalized to `string[]`.
  - `imageConstraint`: size constraint for inline images (undocumented in mirror).
  Docs example: `"text": {"type":"StructuredText","config":{"label":"Text","labels":["superscript"],"multi":"paragraph,strong,em"}}`.
- API filled (`pages/fields/rich-text.md § API response`):
  ```json
  [{"type":"heading1","text":"Build a website that grows","spans":[]},
   {"type":"paragraph","text":"Empower marketers to release on-brand pages fast.","spans":[{"type":"em","start":45,"end":48}]}]
  ```
  Block types: text blocks `heading1..6, paragraph, preformatted, list-item, o-list-item` = `{type,text,spans,direction?}`; `image` block =
  image object + `type` (+ optional `linkTo` link); `embed` block = `{type:"embed", oembed:{...}}`. Spans: `strong`, `em`
  (`{start,end,type}`), `hyperlink` (`data` = link value, may carry `target:"_blank"`), `label` (`data:{label}`). Live counts across
  ~9,600 blocks: paragraph 4572, list-item 1713, heading3 1079, heading2 889, image 525, preformatted 337, o-list-item 223, heading4 146,
  heading1 100, embed 4; spans hyperlink 1294, strong 1217, label 775, em 142 (`ev/search.*.json`).
- Empty: `[]` (live e.g. `"subheading": []`). A cleared editor can also leave `[{"type":"paragraph","text":"","spans":[]}]`
  (live `hidden_content`, `ev/field-shapes.observed.md § object:content,hidden_content,icon,title`); SDK treats a single empty block as empty.
- **[DISCREPANCY]** `direction`: Migration API says the "Value can only be `"rtl"`" (`pages/migration-api-technical-reference.md § Rich text`),
  but live content carries `"direction": "ltr"` on ~60% of blocks (`ev/field-shapes.observed.md § rt-block:heading2`). The read API must
  pass through `ltr`.
- Image blocks live: `url` includes `auto=compress,format` and, when cropped, `&rect=x,y,w,h&w=..&h=..`; `edit.background` may be `"#fff"`.
- Span offsets: `start`/`end` code-unit offsets into `text` (docs don't say whether UTF-16 or code points; see open questions). Docs:
  "Spans can overlap" (`pages/migration-api-technical-reference.md § Rich text`).

### 2.10 Image

- Purpose: "upload, crop, and manage images"; served through imgix (`pages/fields/image.md`). Editor: crop button; alt text
  (`pages/page-fields.md § Image field`).
- Model (`ti/src/model/image.ts`): `{"type":"Image","config":{"label","placeholder","constraint"?: {width?,height?},
  "thumbnails"?: [{name,width?,height?}]}}`. Side constraints accept integers, `"100"`, `"100px"`, `"auto"`/`""`/`null` (= free).
- Editor: "Images can be configured with multiple responsive sizes. Content writers can upload differently sized images with predetermined
  dimensions" (`pages/fields/image.md § (Optional) Add responsive sizes`). "Responsive sizes are not supported by the Prismic CLI. Add them in
  the Type Builder".
- API filled (`pages/fields/image.md § API response`):
  ```json
  {"id":"uYM_PQJ8VvY","url":"https://images.prismic.io/slicemachine-blank/...roller-skating.png?auto=compress,format",
   "alt":"An illustration of a roller skater.","copyright":null,"dimensions":{"width":2048,"height":1536}}
  ```
  Each responsive size is a sibling key named after the thumbnail (`"Mobile": {id,url,alt,copyright,dimensions,edit}`), its url carrying
  `&w=400&h=300`. **[DISCREPANCY]** docs show `edit` only on thumbnails; live every filled main image also has
  `"edit":{"x":0,"y":0,"zoom":1,"background":"transparent"}` (877/877 field images, `ev/search.*.json`); zoom can be a float (`1.41`).
  Migration API says zoom is "an integer" (`... § Image`).
- URL rules: "All images distributed through the API have an `auto=compress,format` URL parameter" (`pages/fields/image.md § Images are
  automatically compressed`); live also shows `auto=format,compress` order and SVGs on `<repo>.cdn.prismic.io` hosts.
- Empty: `{}` (live 200+ occurrences, e.g. `"social_image": {}`, `ev/field-shapes.observed.md § object:`).

### 2.11 Link

- Purpose: "web links. Relative and absolute URLs are supported, as well as linking to Prismic documents and media"
  (`pages/fields/link.md`). Use Link for "Learn more" links, Content relationship for data structures.
- Model (`ti/src/model/link.ts`): `{"type":"Link","config":{"label","placeholder","useAsTitle"?,"select"?: "web"|"document"|"media"|null,
  "customtypes"?,"masks"?,"tags"?,"allowTargetBlank"?,"allowText"?,"repeat"?,"variants"?: string[]}}`. Unknown `select` values fall back to
  `null` (= any). `masks` is the legacy name of `customtypes` (string or string[]).
- Editor options (`pages/fields/link.md § Add a link field`): **Allow target blank**; **Allow display text** ("Content writers can provide a
  label"); **Variants** ("select from a list of styles you set", e.g. Primary/Secondary); **Make this link repeatable** ("provide multiple links
  from one field"). CLI: `--allow-text --allow-target-blank --repeatable --variant X --allow document|media|web`.
- API filled (`pages/fields/link.md § API response`): `{"link_type":"Web","url":"https://prismic.io"}`, `+ "target":"_blank"`,
  `+ "text":"Click Here","variant":"Primary"`; repeatable = array of links.
- Live shapes (2,288 links): Web `{link_type,url,target?,text?,variant?,key?}`; Document `{id,type,tags,lang,slug,first_publication_date,
  last_publication_date,uid?,[data],link_type,key?,isBroken,text?,variant?,url?}`; Media `{link_type,id,kind,name,size,url,key?}`;
  empty `{"link_type":"Any"}` (213) or `{"link_type":"Any","key":"<uuid>"}` (7, empty item inside a repeatable link).
  `key` (uuid v4) appears on field-level links (always inside repeatable links), never on rich-text span links.
  **[DISCREPANCY]** docs samples omit `key`, `first/last_publication_date`; docs name the link sample key `example_link_to_media`.
- Variant values are stored verbatim (live `"variant":"primary"` and `"Primary"` in different fields).
- Repeatable empty: `[]` (`api-contracts.md § 2`).
- Migration API write format: `link_type` one of Document/Web/Media; Document/Media need `id`; Web needs absolute `url`; `target` only `_blank`;
  `text` optional (`pages/migration-api-technical-reference.md § Link`).

### 2.12 Link to media

- Purpose: "select media from a repository's media library. All media formats are supported" (`pages/fields/link-to-media.md`).
- Model: `Link` with `select:"media"`; supports `allowText` and `variants` (docs list no target-blank or repeat option for it).
- API filled (`pages/fields/link-to-media.md § API response`):
  `{"link_type":"Media","id":"ZfA3AYUHT9oC73Ba","name":"mona-lisa","kind":"image","url":"https://images.prismic.io/...?auto=compress,format",
  "size":"50","height":"500","width":"800"}` (+ `text`, `variant`). Numbers are strings.
- Live file: `{"link_type":"Media","kind":"file","id":"X5w0LxQAACQAYkf4","url":"https://prismic-main.cdn.prismic.io/wroom/...pdf",
  "name":"Prismic Contest Rules 10 29 20.pdf","size":"140563"}`: no width/height for `kind:"file"` (`ev/field-shapes.observed.md § link:Media:file`).
- Empty: **[DISCREPANCY]** live `{"link_type":"Media"}` (31 occurrences, e.g. `video_webm`) whereas the SDK types say `{link_type:"Any"}`.

### 2.13 Content relationship

- Purpose: "link pages through content relationship fields. Developers can then access content from those pages"
  (`pages/fields/content-relationship.md`).
- Model: `Link` with `select:"document"`, `customtypes` (allowed types + field selection) and optional `tags`. CLI: `--custom-type author
  --field name --field profession.name --tag featured` (`... § Add a content relationship`).
- `customtypes` grammar (`ti/src/model/link.ts`): array of either type IDs (strings) or `{id, fields:[...]}`; fields are strings,
  `{id:<group>, fields:[string...]}` (group sub-fields) or `{id:<cr field>, customtypes:[ level-2 ]}` (nested relationship); level 2 allows
  strings or `{id:<group>, fields:[string]}`. Constraints: no duplicates; "Cannot have multiple custom types with fields selection";
  "Cannot mix custom types as strings and objects with fields". Hence the docs rule "Up to 2 levels of nested fields can be selected (e.g.
  `blog` -> `author` -> `profession`)" (`... § Select the fields to fetch`) and "Slice Zone fields cannot be fetched from content relationships".
- Docs example of selection: `name`, `profession.name`; nested menu example selects `links.link`, `links.icon` (group sub-fields).
- Editor: restricting to a type via **Add type**; field picker under **Allowed type**; "The selected fields are included in the project's
  generated TypeScript types".
- API filled (`pages/fields/content-relationship.md § API response`): `{"id":"XxnD3REAACYAk_CJ","type":"author","tags":[],"slug":"ada-lovelace",
  "lang":"en-us","uid":"ada-lovelace","data":{ selected fields, nested relationship with its own data },"link_type":"Document","isBroken":false}`.
  "When a selected field is deleted, it's automatically removed from the API response."
- fetchLinks interplay: live, `data` appears on Document links only when the query sets `fetchLinks=blog_author.name` (1 of 5 links in
  `ev/search.fetchlinks.json`; 0 of 489 links without it, `ev/search.pagesize-101.json`). Whether model-level field selection alone injects
  `data` server-side cannot be confirmed from evidence (open question Q3). GraphQuery is "a legacy API option" for the same purpose
  (`... § GraphQuery (Legacy)`).
- Broken link: `isBroken:true` with `type:"broken_type"`, `slug:"-"` (`api-contracts.md § 2.3`).
- Empty: **[DISCREPANCY]** live `{"link_type":"Document"}` (112 occurrences, e.g. `"additional_author":{"link_type":"Document"}` in
  `ev/search.fetchlinks.json`); SDK types say `{link_type:"Any"}`.
- Query use: `filter.at("my.post.category", "<id>")` (`... § Taxonomies`).

### 2.14 Embed

- Purpose: "provide an oEmbed URL, like a YouTube video or a Spotify song. The oEmbed URL's metadata and HTML content are available"
  (`pages/fields/embed.md`). "This field works with any platform that supports oEmbed" (`pages/page-fields.md § Embed field`).
- Model: `{"type":"Embed","config":{"label","placeholder","useAsTitle"?}}`.
- oEmbed resolution is server-side: the Migration API accepts only `embed_url` ("Other properties will be ignored",
  `pages/migration-api-technical-reference.md § Embed`), and the read API returns the full oEmbed response plus `embed_url`.
- API filled (`pages/fields/embed.md § API response`): `{"height":113,"width":200,"embed_url":"https://www.youtube.com/watch?v=GtuLg6hcV3w",
  "type":"video","version":"1.0","title":"...","author_name":"Prismic","author_url":"...","provider_name":"YouTube","provider_url":"...",
  "cache_age":null,"thumbnail_url":"...","thumbnail_width":480,"thumbnail_height":360,"html":"<iframe ...></iframe>"}`.
  Live: 14 embeds; `width/height` absent on 2, `cache_age` present on only 2 (key set follows the provider response).
- Empty: `{}` (SDK; not observed live). Security: docs warn embedded HTML is injected and XSS-prone ("Only embed HTML from trusted sources").

### 2.15 Geopoint

- Purpose: "geolocation coordinates or a Google Maps URL" (`pages/fields/geopoint.md`); editor: "paste a Google Maps URL to automatically
  extract the coordinates" (`pages/page-fields.md § Geopoint field`).
- Model `{"type":"GeoPoint","config":{"label"}}`.
- API filled `{"latitude":20.632784250388028,"longitude":0.0019419193267822268}`; empty `{}`. Migration API: latitude -90..90, longitude
  -180..180, values may be numeric strings (`... § Geopoint`). Internal storage is `{position:{lat,lng}}` (`ti/src/content/legacy/geopoint.ts`).
  Not observed live. Filter `geopoint.near` exists (`pages/technical-reference/prismicio-client/v7.md § geopointNear()`).

### 2.16 Integration

- Purpose: "integrate third-party data into your repository, such as from e-commerce catalogs or custom APIs" (`pages/fields/integration.md`).
  Gated: "You can request access to this feature via the Prismic Support Portal".
- Model `{"type":"IntegrationFields","config":{"label","placeholder","catalog": "<repository>--<catalog_name>"}}`; e.g. repo `lorem`, catalog
  "my store" -> `lorem--my_store`. "Type Builder doesn't support integration fields yet. Use the Prismic CLI"; Slice Machine required editing JSON
  (`pages/slice-machine.md § Model files`).
- Catalog kinds (`pages/fields/integration.md § Create an integration catalog`):
  1. Pull: Prismic GETs your endpoint (optional Basic auth: token + `:`), JSON `{results_size, results:[{id,title,description,blob,
     image_url?,last_update?}]}`, max 50 items per page with a `page=<n>` param, "Data is pulled every 30 minutes".
  2. Push: `POST https://if-api.prismic.io/if/write/<repo>--<catalog>` with `Authorization: Bearer <token>`, body = array of items
     (same item shape); `POST .../deleteItems` with array of IDs; `POST .../reset` (empty body) deletes all.
  3. Shopify: endpoint `<store>.myshopify.com`, API key, Admin API token, shared secret; scope `read_products`.
  Item `title`, `description`, `image_url` are shown in the editor picker; items sorted by `last_update` desc; `id` "is not exposed through the
  Content API. To expose it, include it in the `blob`".
- Limits: "Each repository supports up to 100,000 catalog items"; plan limits by SKU count.
- API filled = the item's `blob` (or Shopify product): `{"id":6562914664611,"handle":"organic-toast-golden","title":"Organic coffee blend",
  "vendor":"Bare Blends"}`. Empty `null` (SDK). Content version selected by `integrationFieldsRef` in the repository root
  (`pages/technical-reference/prismicio-client/v7.md § getRepository()`). Migration API writes the item ID (string|number)
  (`... § Integration`).

### 2.17 Repeatable group

- Purpose: "a repeatable collection of fields" (`pages/fields/repeatable-group.md`).
- Model (`ti/src/model/group.ts`): `{"type":"Group","fieldset"?,"icon"?,"description"?,"config":{"label","repeat"?: boolean,"fields":{...}}}`.
- Editor: "All field types are supported" inside; can be made non-repeatable ("visually grouping fields ... while preventing content writers from
  repeating them", uncheck **Repeatable** -> `repeat:false`). CLI adds sub-fields with `<group_id>.<field_id>`.
- Nesting: docs say "A repeatable group cannot contain another repeatable group" and "Only one level of nesting is supported".
  **[DISCREPANCY]** the model schema allows a `Group` to contain a `NestedGroup` ("max 2 levels of nesting", `ti/src/model/group.ts:27-37`),
  and `@prismicio/client` value types allow one nested group level (`api-contracts.md § 2.7`). UID and Slices are never allowed inside a group
  (only Nestable types).
- API filled `[{"description":"Carrot","price":55},{"description":"Apple","price":60}]`; non-repeatable: "returns a single-element array".
  Empty `[]`; an item whose fields are all empty may appear as `{}` (live `"table_row":[{"icon":{}, ...}]`).
- Groups are also allowed in shared slice `primary` (`ti/src/model/slice.ts:51-58`); live example `"cards":[{...}]` inside `primary`.

### 2.18 Table

- Purpose: "tabular data ... rows and columns" (`pages/fields/table.md`). "This field is not supported in the GraphQL API or Content API v1. Both
  APIs will return `null`."
- Model `{"type":"Table","config":{"label"}}`; cell content is rich text restricted to `paragraph,strong,em,hyperlink`
  (`ti/src/model/table.ts` `TableCellModel`).
- API filled: **[DISCREPANCY]** docs show `{"head":[{"cells":[{"type":"header","content":[...]}]}] "body":[...]}` (array, no keys, and a missing
  comma). Live (`ev/field-shapes.observed.md § table`):
  ```json
  {"head":{"rows":[{"key":"6fc05d69-...","cells":[{"key":"b5bb7a78-...","type":"header",
     "content":[{"type":"paragraph","text":"Platform","spans":[],"direction":"ltr"}]}]}]},
   "body":{"rows":[{"key":"9616dbde-...","cells":[{"key":"8203224f-...","type":"data",
     "content":[{"type":"paragraph","text":"Prismic","spans":[{"start":0,"end":7,"type":"strong"}],"direction":"ltr"}]}]}]}}
  ```
  Implement the live shape. `head` optional; body cells may be `header` or `data`. Empty `null`.

### 2.19 Legacy / undocumented field types

- `Separator` (`{"type":"Separator","config":{"label"}}`): editor-only divider, no API value **[INFERENCE]**.
- `Range`: legacy numeric slider (same config as Number).
- `Choice`: legacy name of the slice zone type (`ti/src/model/slices.ts:6`).
- `Repeatable.Link`: meta type for repeatable links in tooling (`ti/src/model/widget.ts:60`).

### 2.20 Summary: API value per field

| Field | Model `type` (+config) | Filled | Empty (live where seen) |
|---|---|---|---|
| Boolean | `Boolean` | `true`/`false` | `false` or default (never null) |
| Color | `Color` | `"#5B295F"` | `null` |
| Date | `Date` | `"2030-01-31"` | `null` |
| Timestamp | `Timestamp` | `"2030-01-31T05:00:00+0000"` | `null` |
| Number | `Number` | `3.14` | `null` |
| Text | `Text` | `"Lorem ipsum"` | `null` |
| Select | `Select` | `"Medium"` | `null` (or default) |
| UID | `UID` (id `uid`) | top-level `uid` | `null` |
| Rich text / title | `StructuredText` (`multi`/`single`) | block array | `[]` |
| Image | `Image` | object (+thumbnail keys) | `{}` |
| Link | `Link` | `{link_type:"Web"/"Document"/"Media",...}` | `{"link_type":"Any"}` |
| Repeatable link | `Link` `repeat:true` | array with `key` per item | `[]` |
| Link to media | `Link` `select:"media"` | `{link_type:"Media",id,name,kind,url,size,...}` | `{"link_type":"Media"}` |
| Content relationship | `Link` `select:"document"` | `{link_type:"Document",id,type,...}` | `{"link_type":"Document"}` |
| Embed | `Embed` | oEmbed + `embed_url`, `html` | `{}` |
| Geopoint | `GeoPoint` | `{latitude,longitude}` | `{}` |
| Integration | `IntegrationFields` | catalog `blob` | `null` |
| Group | `Group` | array of objects | `[]` |
| Table | `Table` | `{head?,body}` rows/cells with keys | `null` |
| Slice zone | `Slices` | slice array | `[]` |

---

## 3. Slices

### 3.1 Concepts

- "Slices are sections of a website page — like a block of text, a hero, or a call to action. They are modeled using a collection of fields";
  "Content writers build website pages using a stack of slices"; "Developers control which slices are available" per page type; "slices can be
  made available to multiple page types" (`pages/slices.md § What are slices?`).
- "A slice needs to be added to at least one page type before the slice can be used" (`pages/slices.md § How to create a slice`, step 4).
- Three generations of slice models (`ti/src/model/slice.ts:9-37`):
  1. **Legacy simple** (before 2020): a bare Nestable field or nested group used directly as a slice choice.
  2. **Composite** (`"type":"Slice"`, 2020-2021): defined inline inside one type; keys `fieldset` (display name), `description`, `icon`, `display`
     (e.g. `"list"`), `non-repeat` (fields) and `repeat` (repeatable zone), `config.label`.
  3. **Shared** (`"type":"SharedSlice"`, 2021-present): stored once per repository, referenced from types by ID; has variations.
- Legacy Builder slices "are defined inside each type. The Type Builder cannot edit them until you upgrade them"
  (`pages/legacy-builder.md § Migrate to the Type Builder`). Its "slice library" saved copies: "changes to the original are not reflected in the
  copy" (`pages/legacy-builder.md § Reuse slices across custom types`). Shared slices are "slices created with the Type Builder, the Prismic CLI,
  or Slice Machine. If your repository does not have them, reach out to the team to activate it" (`pages/custom-types-api.md § All shared slices`).

### 3.2 Slice zone config

`{"type":"Slices"|"Choice","fieldset"?: string|null,"config":{"label"?,"labels"?: {<sliceId>:[{name,display?}]}|null,"choices":{<sliceId>: SliceModel}}}`
(`ti/src/model/slices.ts`). The default zone key is `slices`; "the developer can change the name of the slice zone and add other slice zones"
(`pages/migration-api-technical-reference.md § Slice zone`); older types use `body` (`pages/legacy-builder.md`). In a type stored in the repository,
shared slices appear as `{"type":"SharedSlice"}` refs; the API-facing "static" form inlines the full shared slice model (`toStatic()`).
`config.labels` defined per-slice label options for legacy slices (surfaced as `slice_label`).

### 3.3 Shared slice model JSON

Schema (`ti/src/model/slice.ts:43-73`): `{id, type:"SharedSlice", name, description?, variations:[Variation], legacyPaths?}`;
Variation = `{id, name, description, imageUrl (default placeholder png), docURL, version, display?, primary?: {field: Nestable|Group},
items?: {field: Nestable}}`. Schema 4.5.0 requires at least one variation and unique variation IDs.

Docs example (`pages/custom-types-api.md § Insert a new Shared slice`):

```json
{
  "id": "image_gallery",
  "type": "SharedSlice",
  "name": "ImageGallery",
  "description": "ImageGallery",
  "variations": [
    {
      "id": "default",
      "name": "Default",
      "docURL": "...",
      "version": "sktwi1xtmkfgx8626",
      "description": "Text",
      "primary": {
        "text": {
          "type": "StructuredText",
          "config": { "label": "Text", "placeholder": "Text with rich formatting", "allowTargetBlank": false, "multi": "paragraph" }
        }
      },
      "items": {},
      "imageUrl": "https://images.prismic.io/tutorial-series/shared-slices/image_gallery/preview.png"
    }
  ]
}
```

- Variations: "Multiple versions of a slice"; "Each variation has its own set of fields"; "Slices are created with a default variation named
  "Default"" (ID `default`); variation ID "Use a short, camel-cased name" (e.g. `withButton`); "Duplicate from" copies fields
  (`pages/slices.md § Slice variations`). Components switch on `slice.variation`.
- primary vs items: `primary` holds the variation's fields (may include groups). `items` is the deprecated repeatable zone: "The `items` property
  is deprecated. It is replaced by repeatable groups" (`pages/slices.md § API Response`). Composite slices used `non-repeat`/`repeat` for the same
  two zones; GraphQL exposes them as `primary` and `fields` (`pages/graphql-technical-reference.md § Slices`).
- Screenshots: per variation `imageUrl`; uploaded via Type Builder "**...** → Update screenshot" or `npx prismic slice edit-variation default
  --screenshot ./my-screenshot.png --from-slice call_to_action` ("The screenshot is uploaded to Prismic", `pages/slices.md § How to create a slice`).
  Stored under `images.prismic.io/<repo>/shared-slices/<slice>/...`. Default placeholder:
  `https://images.prismic.io/slice-machine/621a5ec4-0387-4bc5-9860-2dd46cbc07cd_default_ss.png?auto=compress,format` (`ti/src/model/slice.ts:40`).
- Mocks / simulator: "mock data: JSON that imitates content from the Prismic API to simulate slices in the slice simulator" (`pages/glossary.md`);
  simulator page usually `/slice-simulator`, loaded in an iframe by the Type Builder (**Preview**) and Page Builder, URL stored per repository
  (`pages/slices.md § Simulate slices`; `npx prismic preview set-simulator`, `pages/slice-machine.md § Slice simulator page`).
- `version`: opaque variation version hash (live `sktwi1xtmkfgx8626`, `sktwi1xtmkfgx86242236`) or `"initial"`; copied into each slice instance.

### 3.4 Slice API shape

Docs (`pages/slices.md § API Response`):

```json
{"id":"quote$e568fae3-e996-43c2-af06-dbf42b215cc2","slice_type":"quote","variation":"default","version":"initial",
 "primary":{"quote":"Lorem ipsum dolor sit amet, consectetur adipiscing elit."},"items":[]}
```

Live (1,983 slices, `ev/search.*.json`): every slice has exactly the keys `variation, version, items, primary, id, slice_type, slice_label`
(that order); `slice_label` is always `null` **[DISCREPANCY: docs sample omits `slice_label`]**; `id` always `<slice_type>$<uuid v4>`;
`items` is `[]` (848) or `[{}]` (686, item zone with no fields), otherwise objects; `primary` may be `{}`.
Migration API: `slice_type` and `variation` required; `id` optional "in the following format: `slice_type` + `$` + `uuid v4`. Must be unique within
the page. If omitted, it will be generated"; `slice_label` "If omitted, it will be set to `null`" (`pages/migration-api-technical-reference.md § Slice zone`).
Legacy/composite slices: `{slice_type, slice_label, id, primary, items}` without `variation`/`version` (`api-contracts.md § 2.6`; not observed live).
Internal storage keeps slice items as `{key, name, maybeLabel, widget}` (`ti/src/content/slices.ts:17-25`), i.e. `id` = key, `slice_type` = name,
`slice_label` = maybeLabel **[INFERENCE]**.
Upgrading a legacy slice changes the content shape: "After the push, the Content API returns the new content shape for every document as soon as
anyone publishes" (`pages/legacy-builder.md § Migrate to the Type Builder`).

---

## 4. Type Builder vs Slice Machine vs Legacy Builder

| | Legacy (Custom Type) Builder | Slice Machine | Type Builder + Prismic CLI |
|---|---|---|---|
| Status | Deprecated: "no longer maintained and is only intended for older projects" (`pages/legacy-builder.md`) | Deprecated: "Existing projects still work. New projects must use the Type Builder" (`pages/slice-machine.md`) | Current (tag "new"; `pages/type-builder.md`) |
| Runs | Hosted, "custom types tab of your repository", drag-and-drop + **JSON Editor** tab | Local app `npx start-slicemachine`, `http://localhost:9999` | Cloud UI ("Switch to type builder") + CLI (`npx prismic`) for agents |
| Source of truth | Repository | Code (`slicemachine.config.json`, `customtypes/`, slice libraries), pushed via **Review changes → Push** | Both: Type Builder saves to repository; `pull` makes repo truth, `push` makes local truth |
| Slices | Composite slices inline per type, slice library copies | Shared slices in slice libraries | Shared slices |
| Versioning | Copy JSON into `custom_types/` + `index.json` manifest by hand (`pages/legacy-builder.md § Version custom types`) | Git | Git ("Content models synced with the Prismic CLI can be versioned", `pages/glossary.md § versioning`) |
| Extras | JSON editor for min/max, rich text labels, API ID edits | Integration fields and labels only via JSON (`pages/slice-machine.md § Model files`); environments switcher | Integration fields only via CLI; labels only via JSON; responsive image sizes only via Type Builder |

- Manifest example (Legacy): `[{"id":"bloghome","name":"Blog Home","repeatable":false,"value":"bloghome.json"}, ...]` (`pages/legacy-builder.md`).
- Sync transport: the **Types API** at `https://customtypes.prismic.io` (`GET /customtypes`, `GET /customtypes/{id}`, `POST /customtypes/insert`
  201/409, `POST /customtypes/update` 204/422, `DELETE /customtypes/{id}` 204; same for `/slices`), headers `repository` + bearer write token
  (`pages/custom-types-api.md`). prismic-ts-codegen can fetch models remotely with `customTypesAPIToken` ("Local models take priority",
  `pages/technical-reference/prismic-ts-codegen/v1.md`). Detailed API contract is covered by the API REA doc.
- **2026 transition**: Type Builder + CLI replace both older tools. Migration:
  - From Slice Machine: push pending changes, `npx prismic init` "Replaces `slicemachine.config.json` with `prismic.config.json`", "Pulls models",
    "Uninstalls Slice Machine" (`pages/slice-machine.md § Migrate to the Type Builder`). CLI model commands (`type, slice, field, push, pull, sync,
    status, gen`) must not be used in an SM project.
  - From Legacy: `npx prismic init --repo <repo>` "turns on the Type Builder for your repository. The Legacy Builder turns off"; then
    `npx prismic slice list --legacy` and `npx prismic slice upgrade-legacy hero --from blog_post` per legacy slice, then `npx prismic push`;
    repeat until "No legacy slices found." Requires Administrator role (`pages/legacy-builder.md § Migrate to the Type Builder`).
  - The repository therefore carries a per-repo "builder mode" flag (legacy vs Type Builder) **[INFERENCE]**.
- CLI modeling surface (`pages/content-modeling.md`, `pages/slices.md`, `pages/fields/*.md`): `type create "<Name>" [--format page] [--single]`,
  `slice create "<Name>"`, `slice add-variation "<Name>" --to <slice>`, `slice edit-variation <id> --screenshot <png> --from-slice <slice>`,
  `slice connect <slice> --to <type>`, `field add <kind> <id> --to-slice|--to-type <id> [kind options]`; kinds `boolean, color, content-relationship,
  date, embed, geopoint, group, image, integration, link, number, rich-text, select, table, text, timestamp`. CLI regenerates TypeScript types and
  component stubs and adds a route for each new page type.

---

## 5. Limits, naming and reserved names

Documented limits are sparse. The rest of the table comes from the SDK validators or is marked as unknown.

| Topic | Rule | Source |
|---|---|---|
| Type API ID | Snake-cased; immutable after creation; IDs of deleted types may stay reserved | `pages/content-modeling.md § How to create a page type`; `pages/legacy-builder.md § Change a Custom Type API ID`, `§ Delete` |
| Legacy auto-ID | "All spaces are replaced with underscores", "uppercase ... converted to lowercase", duplicates get a numeric suffix (`text_field1`) | `pages/legacy-builder.md § Change a Custom Type API ID` |
| SDK ID normalizers | type ID: NFD, strip marks, lowercase, `[^a-z0-9]+` -> `_`, trim `_`; field ID helper -> camelCase; slice helper -> PascalCase | `ti/src/helpers/customTypeModel.ts` `serializeID`, `fieldModel.ts`, `sliceModel.ts` |
| Field key charset | must not contain `<` or `>` | `ti/src/common/widgetKey.ts` |
| Field ID uniqueness | unique across all tabs of a type (4.5.0 schema) | `ti/src/model/customType.ts:59-66` |
| Slice names / variation IDs | slice name pascal-case (also component name); variation ID camel-case; slice API ID snake-case (`call_to_action`) | `pages/slices.md`; `pages/slice-machine.md § Create a slice` |
| UID | field ID must be `uid`; one per type; not in slices/groups; only reusable types; lowercase, no spaces, only `-`/`_` specials; unique per type+locale; old UIDs remain resolvable until reused | `pages/fields/uid.md` |
| Group nesting | docs: no group in group; schema: one nested group level | `pages/fields/repeatable-group.md`; `ti/src/model/group.ts` |
| Slice placement | slices only in slice zones; slice `primary` may contain groups; `items` only nestables | `ti/src/model/slice.ts` |
| CR field selection | 2 levels; one type with field selection; no slice zone fields | `pages/fields/content-relationship.md`; `ti/src/model/link.ts` |
| Shared slice | >= 1 variation; unique variation IDs | `ti/src/model/slice.ts:83-108` |
| Integration catalogs | 100,000 items per repository; pull pages of 50; pull every 30 min | `pages/fields/integration.md` |
| Select options | strings (numbers/booleans coerced) | `ti/src/model/select.ts` |
| Number | `min`/`max` enforced on write | `pages/migration-api-technical-reference.md § Number` |
| Geopoint | lat [-90,90], lng [-180,180] | `pages/migration-api-technical-reference.md § Geopoint` |
| Color | `#RGB` or `#RRGGBB` | `ti/src/common/hexaColorCode.ts` |
| Max fields per type, max slices per zone, max tabs, max types, max ID length | **not documented** | (open question Q6) |

Reserved names: only `uid` is reserved by documentation. Document envelope keys (`id`, `type`, `tags`, `lang`, ...) cannot collide because fields live
under `data`. Slice zone key defaults to `slices` but is not reserved.

---

## 6. Requirements

### Model / types / slices / builder (REQ-MOD)

- **REQ-MOD-001 (P0)** Store and serve custom type models with envelope `{id, label, repeatable, json, status, format}` and defaults
  `repeatable:true`, `status:true`, `format:"custom"`; accept optional `schema:"@prismicio/types-internal@4.5.0"`.
- **REQ-MOD-002 (P0)** Treat `json` as ordered tabs of fields; flatten tabs into one `data` object in the Content API; reject duplicate field IDs
  across tabs.
- **REQ-MOD-003 (P0)** Validate models with the same rules as `@prismicio/types-internal` (field types list of §2.0, config keys of §2, nesting
  rules of §5), tolerating legacy forms (string `min/max`, `"100px"` constraints, legacy `labels` object, `masks`, `Choice`).
- **REQ-MOD-004 (P0)** Enforce Single types: at most one published document per `repeatable:false` type (per locale **[INFERENCE]**).
- **REQ-MOD-005 (P0)** Expose `id -> label` of all types in the Repository API `types` map.
- **REQ-MOD-006 (P0)** Store shared slices separately (`{id, type:"SharedSlice", name, description?, variations[]}`) and resolve
  `{"type":"SharedSlice"}` refs in slice zone `choices`; drop refs to missing slices (`filterMissingSharedSlices`).
- **REQ-MOD-007 (P0)** Serve slices as `{id:"<slice_type>$<uuidv4>", slice_type, slice_label, variation, version, primary, items}` for shared
  slices, and `{id, slice_type, slice_label, primary, items}` for composite/legacy slices; generate IDs when absent; enforce uniqueness per document.
- **REQ-MOD-008 (P0)** Copy the variation `version` hash into slice instances; emit `slice_label: null` when unset.
- **REQ-MOD-009 (P0)** Support composite slices (`type:"Slice"`, `non-repeat`/`repeat`) and legacy simple slices for content created with the
  Legacy Builder.
- **REQ-MOD-010 (P0)** Project stored content through the current model when serving: absent fields return their empty value; removed fields
  disappear; renamed fields start empty; stored data for removed fields is retained so it reappears if the field is re-added with the same ID/type.
- **REQ-MOD-011 (P1)** Apply model changes to the Content API only after the next publish/archive (new ref), as documented.
- **REQ-MOD-012 (P0)** Apply Boolean/Select `default_value` and group item defaults on write and read (`withDefaultContent`).
- **REQ-MOD-013 (P1)** Implement a Types API compatible with `customtypes.prismic.io` (insert 201/409, update 204/422, delete 204, list/get,
  slices endpoints) so the Prismic CLI, prismic-ts-codegen and Slice Machine can push/pull (contract in API REA doc).
- **REQ-MOD-014 (P1)** `status:false` disables creation of new documents of that type while keeping existing ones readable.
- **REQ-MOD-015 (P1)** Type deletion requires no remaining documents; keep tombstones so deleted model JSON is recoverable and the ID policy is
  explicit.
- **REQ-MOD-016 (P1)** Type IDs are immutable; slice ID change drops slice content.
- **REQ-MOD-017 (P1)** Store variation screenshots (`imageUrl`) as media served from the image CDN; default to the placeholder URL.
- **REQ-MOD-018 (P1)** Store a per-repository slice simulator URL used by the modeling UI and Page Builder.
- **REQ-MOD-019 (P1)** Provide a web modeling UI (Type Builder equivalent): page types / custom types / slices lists, reusable vs single, tabs,
  static zone, slice zone with "reuse existing slice", variations with "duplicate from", field settings per §2.
- **REQ-MOD-020 (P1)** Support `format:"page"` creation with default UID and SEO fields and an auto-added route; `format:"custom"` with slices
  disabled by default.
- **REQ-MOD-021 (P2)** Legacy-builder style JSON editor for raw model editing (labels, min/max, API ID edits).
- **REQ-MOD-022 (P2)** Legacy slice upgrade path (composite -> shared) with content shape migration on next publish.
- **REQ-MOD-023 (P2)** Per-repository builder mode flag (legacy vs Type Builder) if legacy repositories are imported.
- **REQ-MOD-024 (P1)** Model export/import as `customtypes/<id>/index.json` and `<lib>/<Slice>/model.json` file trees for git versioning.

### Fields (REQ-FLD)

- **REQ-FLD-001 (P0)** Every field type of §2.20 returns exactly the filled/empty shapes listed, including the live-observed empties
  (`{"link_type":"Document"}` for empty content relationships, `{"link_type":"Media"}` for empty link-to-media, `{}` for image/geopoint/embed).
- **REQ-FLD-002 (P0)** Boolean never null; default `false` unless `default_value:true`; `placeholder_true/false` editor-only.
- **REQ-FLD-003 (P0)** Color validated as hex; returned as stored string.
- **REQ-FLD-004 (P0)** Date `YYYY-MM-DD`; Timestamp `YYYY-MM-DDTHH:MM:SS+0000` always UTC.
- **REQ-FLD-005 (P0)** Number returns JSON number; enforce `min`/`max` on write; `step` editor hint.
- **REQ-FLD-006 (P0)** Select value must be one of `options`; `default_value` applied when empty.
- **REQ-FLD-007 (P0)** Text returns string or `null`.
- **REQ-FLD-008 (P0)** UID: top-level `document.uid`; field ID `uid`; one per reusable type; charset lowercase `[a-z0-9_-]` without spaces;
  unique per type+locale; retain previous UIDs as aliases for `getByUID` until reused.
- **REQ-FLD-009 (P1)** UID auto-generated from content when left empty.
- **REQ-FLD-010 (P0)** Rich text blocks/spans exactly as §2.9, including `direction` pass-through (`ltr`/`rtl`), `label` spans with `data.label`,
  hyperlink spans carrying link objects (no `key`), image blocks with optional `linkTo`, embed blocks with `oembed`.
- **REQ-FLD-011 (P0)** Enforce `multi`/`single` allowed node lists on write (error format like Migration API "Invalid block type. Supported block
  types are: ..."); `single` limits the field to one block.
- **REQ-FLD-012 (P1)** Rich text `labels` and `allowTargetBlank` honored in the editor; `rtl` token enables RTL direction.
- **REQ-FLD-013 (P0)** Image value `{id,url,alt,copyright,dimensions,edit}` with `edit` always present when filled; url with
  `auto=compress,format` and crop params (`rect`, `w`, `h`) when cropped.
- **REQ-FLD-014 (P0)** Image thumbnails: one sibling key per `config.thumbnails[].name`, each a full image object with its own crop; always filled
  when the main image is filled.
- **REQ-FLD-015 (P1)** Image `constraint` (and rich text `imageConstraint`) enforce/crop to fixed dimensions in the editor.
- **REQ-FLD-016 (P0)** Link values per `link_type` (Web/Document/Media/Any) with optional `target:"_blank"`, `text`, `variant`; `key` uuid on
  field-level links; repeatable links as arrays with per-item `key`.
- **REQ-FLD-017 (P0)** Document links include `id,type,tags,lang,slug,first_publication_date,last_publication_date,uid?,link_type,isBroken`,
  plus `url` when routes resolve and `data` when fetchLinks/graphQuery (and possibly model field selection) request it.
- **REQ-FLD-018 (P0)** Broken document links: `isBroken:true`, `type:"broken_type"`, `slug:"-"`, null dates.
- **REQ-FLD-019 (P1)** Link config `select`, `allowText`, `allowTargetBlank`, `repeat`, `variants` drive the editor and write validation.
- **REQ-FLD-020 (P0)** Link-to-media values with string `size`/`height`/`width`, `kind` `image` or `file` (no dimensions for files).
- **REQ-FLD-021 (P0)** Content relationship `customtypes` and `tags` restrict selectable documents (editor and write validation).
- **REQ-FLD-022 (P1)** Content relationship field selection (2 levels, group sub-fields, nested relationships, no slice zones) stored in the model
  and used for typegen; behaviour on the read API per Q3.
- **REQ-FLD-023 (P0)** Embed: server-side oEmbed resolution from `embed_url`, storing provider response + `embed_url` + `html`; empty `{}`.
- **REQ-FLD-024 (P1)** Embed provider discovery for arbitrary oEmbed providers (YouTube, Spotify, Twitter/X, ...).
- **REQ-FLD-025 (P0)** Geopoint `{latitude,longitude}` numbers, range-validated; empty `{}`.
- **REQ-FLD-026 (P1)** Geopoint editor accepts a Google Maps URL and extracts coordinates.
- **REQ-FLD-027 (P1)** Integration fields: catalogs (pull every 30 min with 50-item pages and optional Basic auth; push API with Bearer token,
  `deleteItems`, `reset`; Shopify sync), catalog ID `<repo>--<name>`, value = item `blob`, `integrationFieldsRef` versioning, 100k items cap.
- **REQ-FLD-028 (P0)** Integration field value returned as stored blob; empty `null`.
- **REQ-FLD-029 (P0)** Group returns array of item objects; non-repeatable group returns single-element array; empty `[]`; allow one nested
  group level (schema) while the editor may hide it (docs).
- **REQ-FLD-030 (P0)** Table returns the live shape `{head?:{rows:[{key,cells:[{key,type,content}]}]},body:{rows:[...]}}` with cell rich text
  limited to `paragraph,strong,em,hyperlink`; empty `null`; GraphQL/API v1 return `null`.
- **REQ-FLD-031 (P2)** Accept legacy `Separator` and `Range` model types; Separator produces no data.
- **REQ-FLD-032 (P0)** Field keys: reject `<`/`>`; unique within their container.
- **REQ-FLD-033 (P1)** Editor labels/placeholders from `config.label`/`config.placeholder`; date display in browser locale.

---

## 7. Open questions and ambiguities

- **Q1 Empty link shapes.** Live returns `{"link_type":"Document"}` / `{"link_type":"Media"}` for empty CR / LTM, SDK types say `Any`. Is the
  empty `link_type` derived from `config.select`, or from what was previously stored? Needs a probe with a freshly added CR field.
- **Q2 Table shape.** Docs sample (array head/body, no keys) vs live (`rows` + `key`). Was the docs shape ever served (older API version)?
- **Q3 CR field selection vs fetchLinks.** Docs: selected fields are "included in the API response". Live shows `data` only with explicit
  `fetchLinks`. prismic-main may not use model field selection; needs a probe on a repo that does.
- **Q4 Group nesting.** Docs forbid nested groups; schema allows one nested level. Which does the Type Builder allow today?
- **Q5 `items: [{}]` vs `[]`.** Rule for when an empty item zone serializes as `[{}]` (observed 686 times).
- **Q6 Quantitative limits.** Max fields per type/slice, max slices per page, max tabs, max types/slices per repo, max API ID length, max text
  lengths: none documented.
- **Q7 Span offsets.** UTF-16 code units (JS) or Unicode code points? Matters for emoji/non-BMP text.
- **Q8 `direction:"ltr"`.** Emitted by the editor for newer blocks; Migration API claims only `rtl` is valid. Is `ltr` accepted on write?
- **Q9 SEO fields of page types.** Exact default fields/IDs/tab name created with `format:"page"` are not documented.
- **Q10 Variation/slice version hash.** How `version` is computed (`"initial"` vs `sktwi...`) and whether clients depend on it.
- **Q11 ID normalizers.** SDK helpers produce camelCase field IDs and PascalCase slice/variation IDs, while docs recommend snake_case field IDs and
  camelCase variation IDs. Which casing does the Type Builder auto-suggest?
- **Q12 UID uniqueness scope across singles and archived/deleted documents**, and when an old UID alias is released.
- **Q13 Single type uniqueness per locale.** Docs say "Only one page of this type can be published"; presumably one per locale.
- **Q14 Model change visibility.** Exactly which ref the model is bound to (models snapshot per release/ref?) given "not reflected until at least one
  page is published or archived".
- **Q15 Integration field empty value and stale items.** What is returned when a referenced catalog item is deleted (`reset`)?
- **Q16 Rich text `imageConstraint`, `useAsTitle`, `Range`, `Separator`** are in the schema but undocumented; their editor behaviour is unknown.
