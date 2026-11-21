// Software credential for exercising the normal WebAuthn registration and assertion flows.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

export function authenticator(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const idBytes = randomBytes(32);
  const id = idBytes.toString("base64url");
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const client = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    id,
    register(challenge: string) {
      const data = Buffer.concat([
        rpHash,
        Buffer.from([69, 0, 0, 0, 0]),
        Buffer.alloc(16),
        Buffer.from([0, 32]),
        idBytes,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", data],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client("webauthn.create", challenge).toString(
            "base64url",
          ),
          attestationObject: Buffer.from(attestation).toString("base64url"),
        },
      };
    },
    authenticate(challenge: string, user: string) {
      const clientData = client("webauthn.get", challenge);
      const data = Buffer.concat([rpHash, Buffer.from([5, 0, 0, 0, 1])]);
      const signature = sign(
        "sha256",
        Buffer.concat([data, createHash("sha256").update(clientData).digest()]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: Buffer.from(user).toString("base64url"),
        },
      };
    },
  };
}
