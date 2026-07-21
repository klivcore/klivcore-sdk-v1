import { verifyRealmEndpoint } from "./conformance";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: bun run conformance <realm-gateway-endpoint>");
  process.exit(2);
}

try {
  console.log(JSON.stringify(await verifyRealmEndpoint(endpoint), null, 2));
} catch (error) {
  console.error(`Realm conformance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
