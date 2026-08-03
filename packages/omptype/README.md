# @oh-my-pi/omptype

Fast, ArkType-compatible schema validation for JavaScript and TypeScript.
Schemas start with a small interpreter and lazily compile after repeated use,
keeping construction cheap without giving up hot-path validation speed.

## Installation

```sh
npm install @oh-my-pi/omptype
# or
bun add @oh-my-pi/omptype
```

Runs on Node 20+ (published as compiled ESM with bundled type declarations)
and Bun 1.3.14+ (which resolves the TypeScript source directly via the `bun`
export condition). No runtime dependencies.

## Usage

```ts
import { type } from "@oh-my-pi/omptype";

const Config = type({
	name: "string",
	"retries?": "number.integer >= 0",
	enabled: "boolean = true",
});

const config = Config.assert({ name: "worker" });
// { name: "worker", enabled: true }

const result = Config({ name: 42 });
if (result instanceof type.errors) {
	console.error(result.summary);
}
```

Schemas are callable and expose composition (`.or()`, `.and()`, `.array()`,
`.pipe()`, `.narrow()`), object transforms (`.pick()`, `.omit()`, `.partial()`,
`.required()`, `.merge()`, `.map()`), refinements, semantic comparison, error
configuration, and JSON Schema emission.

Built-in keyword modules include `type.string.email`, `type.string.uuid.v4`,
`type.string.date.iso.parse`, `type.string.normalize.NFKC`,
`type.number.integer`, and the parsers under `type.parse`.

## Named and recursive schemas

```ts
const models = type
	.scope({
		User: { name: "string", "manager?": "User" },
		Users: "User[]",
		PublicUser: "Pick<User, 'name'>",
	})
	.export();

models.User.assert({ name: "Ada", manager: { name: "Grace" } });
```

Scopes resolve aliases lazily, including cycles. `type.module()` exports a
scope directly, `type.define()` preserves literal definitions, and
`type.generic("<value>", definition)` builds parameterized runtime schemas.

Failed validation returns `OmpErrors`; each entry exposes `code`, `path`,
`expected`, `actual`, `problem`, and `message`, while the aggregate exposes
`summary` and `byPath`. `.configure()` accepts string or callback overrides for
error text. `.toJsonSchema()` accepts `target`, `dialect`, and `fallback`
options.

## Compatibility adapters

TypeBox-style and Zod-style builders produce native omptype schemas:

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

const TypeBoxUser = Type.Object({ name: Type.String() });
type TypeBoxUser = Static<typeof TypeBoxUser>;

const ZodUser = z.object({ name: z.string() });
const user = ZodUser.parse({ name: "Ada" });
```

`@oh-my-pi/omptype/ark` provides the repository's ArkType compatibility facade
and re-exports the same `type` and `scope` implementations.

## License

MIT
