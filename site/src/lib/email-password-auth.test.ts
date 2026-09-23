import { beforeEach, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { hashPassword } from "better-auth/crypto";
import { emailPasswordDisabledPaths, emailPasswordGuard, emailPasswordOptions } from "@/lib/email-password-auth";

const password = "test-only-account-password-12345";
const db: Record<string, Record<string, unknown>[]> = {};
const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "test-only-auth-secret-with-at-least-32-characters",
  database: memoryAdapter(db),
  emailAndPassword: emailPasswordOptions,
  disabledPaths: emailPasswordDisabledPaths,
  hooks: { before: emailPasswordGuard },
});

beforeEach(async () => {
  db.user = ["first", "second", "google-only"].map((id) => ({
    id, email: `${id}@example.com`, name: id, emailVerified: false,
    createdAt: new Date(), updatedAt: new Date(),
  }));
  const hash = await hashPassword(password);
  db.account = db.user.filter((user) => user.id !== "google-only").map((user) => ({
    id: `${user.id}-credential`, userId: user.id, accountId: user.id,
    providerId: "credential", password: hash, createdAt: new Date(), updatedAt: new Date(),
  }));
  db.session = [];
});

function request(path: string, body: Record<string, unknown>) {
  return auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  }));
}

test("any account with valid password credentials receives a normal session", async () => {
  const callbackURL = "/api/chatgpt/oauth/authorize?state=test";
  for (const email of ["first@example.com", "second@example.com"]) {
    const response = await request("/sign-in/email", { email, password, callbackURL });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    expect((await response.json()).url).toBe(callbackURL);
  }
  expect(db.session).toHaveLength(2);
});

test("wrong passwords and accounts without password credentials are rejected", async () => {
  for (const body of [
    { email: "first@example.com", password: "wrong" },
    { email: "google-only@example.com", password },
    { email: "missing@example.com", password },
  ]) {
    expect((await request("/sign-in/email", body)).status).toBe(401);
  }
  expect(db.session).toHaveLength(0);
});

test("email signup creates a password account that can sign in without an inbox", async () => {
  const credentials = { email: "new@example.com", password };
  const response = await request("/sign-up/email", { ...credentials, name: "New account" });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("session_token");
  const user = (await response.json()).user;
  expect(user.emailVerified).toBe(false);
  expect(db.account.find((account) => account.userId === user.id)?.password).not.toBe(password);
  expect((await request("/sign-in/email", credentials)).status).toBe(200);
});

test("signup cannot overwrite an existing account or accept a short password", async () => {
  expect((await request("/sign-up/email", { email: "first@example.com", password, name: "Other" })).ok).toBe(false);
  expect((await request("/sign-up/email", { email: "new@example.com", password: "short", name: "New" })).ok).toBe(false);
  expect(db.user).toHaveLength(3);
});

test("unconfigured password recovery and password attachment endpoints stay closed", async () => {
  for (const path of emailPasswordDisabledPaths) {
    expect((await request(path, { email: "first@example.com", password })).status).toBe(404);
  }
});

test("external callbacks are rejected for both sign-in and signup", async () => {
  for (const path of ["/sign-in/email", "/sign-up/email"]) {
    const response = await request(path, {
      email: "new@example.com", password, name: "New", callbackURL: "https://attacker.example/",
    });
    expect(response.status).toBe(403);
  }
  expect(db.user).toHaveLength(3);
  expect(db.session).toHaveLength(0);
});
