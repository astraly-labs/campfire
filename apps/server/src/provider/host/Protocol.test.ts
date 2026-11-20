// Hashes the wire contract with Node's SHA-256.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import * as Protocol from "./Protocol.ts";

const contractDigest = () => {
  const documents = Object.entries(Protocol)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([name, value]) =>
      Schema.isSchema(value) ? [[name, Schema.toJsonSchemaDocument(value)]] : [],
    );
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(documents))
    .digest("hex")
    .slice(0, 16);
};

it("changes PROTOCOL_VERSION whenever a provider-host wire schema changes", () => {
  expect(
    { version: Protocol.PROTOCOL_VERSION, contract: contractDigest() },
    "The provider-host wire contract changed. Bump PROTOCOL_VERSION, then pin the new digest.",
  ).toEqual({ version: 3, contract: "3f54940eb69bb3f8" });
});
