// Hashes the wire contract with Node's SHA-256.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import * as Protocol from "./Protocol.ts";

interface Contract {
  readonly ClientMessage: Schema.Top;
  readonly ServerMessage: Schema.Top;
  readonly Operations: Record<
    string,
    { readonly name: string; readonly input: Schema.Top; readonly output: Schema.Top }
  >;
}
// The newest released host or server speaks this contract. Update it when a release ships.
const released = { version: 2, contract: "72effbf81a776bf6" };
const current = { version: 3, contract: "6b89c4d9cc4a96c8" };

const DOCUMENTATION = new Set(["$comment", "description", "documentation", "examples", "title"]);
// Field order and documentation do not change what a peer can decode.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DOCUMENTATION.has(key))
      .map(([key, nested]): [string, unknown] => [
        key,
        key === "required" && Array.isArray(nested) ? nested.toSorted() : canonical(nested),
      ])
      .toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );
};
const digest = (schemas: Record<string, Schema.Top>) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        canonical(
          Object.fromEntries(
            Object.entries(schemas).map(([name, schema]) => [
              name,
              Schema.toJsonSchemaDocument(schema),
            ]),
          ),
        ),
      ),
    )
    .digest("hex")
    .slice(0, 16);
const contractDigest = (contract: Contract) =>
  digest({
    ClientMessage: contract.ClientMessage,
    ServerMessage: contract.ServerMessage,
    ...Object.fromEntries(
      Object.values(contract.Operations).flatMap(({ name, input, output }) => [
        [`${name}.input`, input],
        [`${name}.output`, output],
      ]),
    ),
  });

it("pins the provider-host wire contract to PROTOCOL_VERSION", () => {
  expect(
    { version: Protocol.PROTOCOL_VERSION, contract: contractDigest(Protocol) },
    "The provider-host wire contract changed. Pin its digest, with a version above the released one.",
  ).toEqual(current);
});

it("raises PROTOCOL_VERSION exactly when the contract differs from the released one", () => {
  expect(current.version > released.version).toBe(current.contract !== released.contract);
});

it("digests what a peer decodes, so field order and documentation do not count", () => {
  const fields = { feedbackId: Schema.String, reason: Schema.String };
  const pinned = digest({ result: Schema.Struct(fields) });
  expect(
    digest({ result: Schema.Struct({ reason: fields.reason, feedbackId: fields.feedbackId }) }),
  ).toBe(pinned);
  expect(digest({ result: Schema.Struct(fields).annotate({ description: "Documented." }) })).toBe(
    pinned,
  );
  expect(digest({ result: Schema.Struct({ ...fields, extra: Schema.String }) })).not.toBe(pinned);
});

it("covers the response codec of each operation", () => {
  const changed = {
    ...Protocol.Operations,
    uploadFeedback: {
      ...Protocol.Operations.uploadFeedback,
      output: Schema.Struct({ ...Protocol.FeedbackResult.fields, url: Schema.String }),
    },
  };
  expect(contractDigest({ ...Protocol, Operations: changed })).not.toBe(contractDigest(Protocol));
});
