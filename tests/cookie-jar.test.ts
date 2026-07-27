import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cookieHeaderFor,
  parseCookieJar,
  readCookieJar,
  summarizeCookieJar,
  writeCookieJar,
  type StoredCookie
} from "../src/tools/web/cookieJar.js";

async function main(): Promise<void> {
  testCookieEditorParsing();
  testCookieMatching();
  await testCookieJarPersistence();
  console.log("cookie jar tests passed");
}

function testCookieEditorParsing(): void {
  const cookies = parseCookieJar(JSON.stringify({ cookies: [cookie("session", "value", ".example.com")] }));
  assert.equal(cookies[0]?.domain, ".example.com");
  assert.equal(cookies[0]?.path, "/");
  assert.equal(cookies[0]?.session, true);
  assert.throws(() => parseCookieJar("[]"), /没有可用的 cookie/);
}

function testCookieMatching(): void {
  const cookies: StoredCookie[] = [
    cookie("root", "one", ".example.com"),
    cookie("private", "two", ".example.com", "/private"),
    { ...cookie("host", "three", "example.com"), hostOnly: true },
    { ...cookie("expired", "four", ".example.com"), expirationDate: 1 }
  ];
  assert.equal(
    cookieHeaderFor(cookies, new URL("https://app.example.com/private/document"), 2_000),
    "private=two; root=one"
  );
  assert.equal(
    cookieHeaderFor(cookies, new URL("https://example.com/private"), 2_000),
    "private=two; root=one; host=three"
  );
  assert.equal(cookieHeaderFor(cookies, new URL("http://example.com/private"), 2_000), undefined);
}

async function testCookieJarPersistence(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biny-cookie-jar-"));
  const jarPath = path.join(directory, "cookies.json");
  try {
    const expected = parseCookieJar(JSON.stringify([cookie("sid", "persisted", ".example.com")]));
    await writeCookieJar(jarPath, expected);
    assert.deepEqual(await readCookieJar(jarPath), expected);
    assert.equal((await stat(jarPath)).mode & 0o777, 0o600);
    assert.deepEqual(summarizeCookieJar(expected).domains, [{ domain: "example.com", count: 1 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function cookie(name: string, value: string, domain: string, cookiePath = "/"): StoredCookie {
  return { name, value, domain, path: cookiePath, secure: true, httpOnly: true };
}

await main();
