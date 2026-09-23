import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  CLIENT_ID,
  OAUTH_PATH,
  SCOPES,
  type ChatgptConfig,
} from "@/clients/chatgpt/server/config";

export type IdentityUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

export function identityClaims(user: IdentityUser, scopes: readonly string[]) {
  return {
    sub: user.id,
    ...(scopes.includes("email")
      ? { email: user.email, email_verified: user.emailVerified }
      : {}),
  };
}

export function createIdentitySigner(pem: string) {
  const key = createPrivateKey(pem);
  if (
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error(
      "ChatGPT OpenID signing requires an RSA private key of at least 2048 bits.",
    );
  }
  const { e, n, kty } = createPublicKey(key).export({ format: "jwk" });
  const kid = createHash("sha256")
    .update(JSON.stringify({ e, kty, n }))
    .digest("base64url");
  const jwk = { e, n, kty, kid, use: "sig", alg: "RS256" };
  return {
    jwk,
    sign(
      user: IdentityUser,
      scopes: readonly string[],
      issuer: string,
      expiresIn: number,
      nonce?: string,
    ) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          ...identityClaims(user, scopes),
          iss: issuer,
          aud: CLIENT_ID,
          iat: now,
          exp: now + expiresIn,
          ...(nonce === undefined ? {} : { nonce }),
        }),
      ).toString("base64url");
      const input = `${header}.${payload}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
    },
  };
}

let cached:
  { pem: string; signer: ReturnType<typeof createIdentitySigner> } | undefined;

export function identitySigner() {
  const pem = process.env.CHATGPT_OIDC_PRIVATE_KEY;
  if (!pem)
    throw new Error(
      "CHATGPT_OIDC_PRIVATE_KEY is required for OpenID account linking.",
    );
  if (cached?.pem !== pem) cached = { pem, signer: createIdentitySigner(pem) };
  return cached.signer;
}

export function openIdMetadata(config: ChatgptConfig) {
  const baseUrl = `${config.issuer}${OAUTH_PATH}`;
  return {
    issuer: config.issuer,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    revocation_endpoint: `${baseUrl}/revoke`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    jwks_uri: `${baseUrl}/jwks`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "iat",
      "exp",
      "nonce",
      "email",
      "email_verified",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: SCOPES,
  };
}
