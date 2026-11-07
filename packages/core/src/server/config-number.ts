import * as Schema from "effect/Schema"
import * as Getter from "effect/SchemaGetter"

// Keep Number(text) syntax without accepting NaN from strings or typed providers.
export const numberFromConfig = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.decodeTo(
    Schema.Number.check(
      Schema.makeFilter((value: number) => !Number.isNaN(value), {
        expected: "a number other than NaN",
      })
    ),
    {
      decode: Getter.transform(Number),
      encode: Getter.passthrough(),
    }
  )
)
