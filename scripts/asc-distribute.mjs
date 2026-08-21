#!/usr/bin/env node
// Hands the build that was just uploaded to every external TestFlight group,
// so testers get each ship without anyone opening App Store Connect.
//
//   node scripts/asc-distribute.mjs [--uploaded-after <epoch-seconds>]
//                                   [--wait-minutes 60] [--bundle-id <id>]
//
// App Store Connect takes a few minutes to process an upload, so the script
// polls for the newest build, waits for it to go VALID, turns on the "new
// build" notification, adds it to the external groups, and submits it for
// beta review. Apple releases it to the testers the moment review passes.
//
// Credentials come from an App Store Connect API key (Users and Access →
// Integrations → App Store Connect API, role App Manager):
//
//   DONKEY_ASC_KEY_P8_PATH=/path/AuthKey_XXXX.p8
//   DONKEY_ASC_KEY_ID=XXXX
//   DONKEY_ASC_ISSUER_ID=uuid
//
// With the key dropped in ~/.appstoreconnect/private_keys/AuthKey_XXXX.p8 the
// path and id are read from the filename, and the issuer id from
// ~/.appstoreconnect/private_keys/issuer_id.

import { createSign } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const API = "https://api.appstoreconnect.apple.com"
const KEY_DIR = join(homedir(), ".appstoreconnect", "private_keys")

const args = parseArgs(process.argv.slice(2))
const bundleId = args["bundle-id"] ?? "com.donkeycut.donkeycut"
const uploadedAfter = Number(args["uploaded-after"] ?? 0) * 1000
const waitMs = Number(args["wait-minutes"] ?? 60) * 60_000

let token = ""

try {
  await distribute()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}

async function distribute() {
  token = mintToken(resolveCredentials())

  const app = (await api(`/v1/apps?filter[bundleId]=${bundleId}&limit=1`)).data[0]
  if (!app) throw new Error(`No App Store Connect app for ${bundleId}`)

  const build = await waitForBuild(app.id)
  log(`Build ${build.attributes.version} is processed`)

  const groups = (await api(`/v1/apps/${app.id}/betaGroups?limit=200`)).data.filter(
    (group) => !group.attributes.isInternalGroup
  )
  if (groups.length === 0) {
    log("No external groups on this app; nothing to distribute")
    return
  }

  const detail = (await api(`/v1/builds/${build.id}/buildBetaDetail`)).data
  await api(`/v1/buildBetaDetails/${detail.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "buildBetaDetails",
        id: detail.id,
        attributes: { autoNotifyEnabled: true },
      },
    },
  })

  for (const group of groups) {
    await api(`/v1/betaGroups/${group.id}/relationships/builds`, {
      method: "POST",
      body: { data: [{ type: "builds", id: build.id }] },
      // Re-running a ship over a build the group already holds is a no-op.
      allow: [409],
    })
    log(`Added ${build.attributes.version} to "${group.attributes.name}"`)
  }

  // External testers only see a build once beta review clears it. Submitting
  // here is what makes the release automatic; a build already in review answers
  // 409 and is left alone.
  await api(`/v1/betaAppReviewSubmissions`, {
    method: "POST",
    body: {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: build.id } } },
      },
    },
    allow: [409],
  })
  log("Submitted for beta review; testers get it as soon as review passes")
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue
    parsed[argv[i].slice(2)] = argv[i + 1]
    i += 1
  }
  return parsed
}

function resolveCredentials() {
  let path = process.env.DONKEY_ASC_KEY_P8_PATH
  let keyId = process.env.DONKEY_ASC_KEY_ID
  let issuerId = process.env.DONKEY_ASC_ISSUER_ID
  if (!path) {
    const file = (existsSync(KEY_DIR) ? readdirSync(KEY_DIR) : []).find((name) =>
      /^AuthKey_.+\.p8$/.test(name)
    )
    if (!file) {
      throw new Error(
        `No App Store Connect API key. Set DONKEY_ASC_KEY_P8_PATH or drop AuthKey_XXXX.p8 in ${KEY_DIR}`
      )
    }
    path = join(KEY_DIR, file)
    keyId ??= file.slice("AuthKey_".length, -".p8".length)
  }
  if (!issuerId) {
    issuerId = readFileSync(join(KEY_DIR, "issuer_id"), "utf8").trim()
  }
  return { privateKey: readFileSync(path, "utf8"), keyId, issuerId }
}

function mintToken({ privateKey, keyId, issuerId }) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = { alg: "ES256", kid: keyId, typ: "JWT" }
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 20 * 60,
    aud: "appstoreconnect-v1",
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
  return `${signingInput}.${signature.toString("base64url")}`
}

function base64url(value) {
  return Buffer.from(value).toString("base64url")
}

async function api(path, { method = "GET", body, allow = [] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (allow.includes(response.status)) return null
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
}

async function waitForBuild(appId) {
  const deadline = Date.now() + waitMs
  let announced = ""
  for (;;) {
    const builds = await api(
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5`
    )
    const build = builds.data.find(
      (candidate) => Date.parse(candidate.attributes.uploadedDate) >= uploadedAfter
    )
    if (build?.attributes.processingState === "VALID") return build
    const state = build ? `${build.attributes.version} ${build.attributes.processingState}` : "upload"
    if (state !== announced) {
      log(`Waiting on ${state}`)
      announced = state
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for App Store Connect to process the upload")
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}

function log(message) {
  process.stdout.write(`${message}\n`)
}
