/// <reference types="node" />
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  createEmailSignupIntent,
  claimEmailSignupDelivery,
  verifyEmailSignupIntent,
} from "../../../../packages/shared/src/db/email-signup-intents";
import { storeVerifiedPasskey } from "../../../../packages/shared/src/db/passkey-credentials";
import { createPasskeyFlow } from "./passkey-flow";
import { syntheticAuthenticator } from "./__fixtures__/webauthn/synthetic";
import { attestationNone } from "./__fixtures__/webauthn/upstream";
function d1Adapter(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string) {
    return {
      bind(...values: SQLInputValue[]) {
        return {
          sql,
          values,
          async all<T>() {
            return { results: sqlite.prepare(sql).all(...values) as T[] };
          },
          async first<T>(): Promise<T | null> {
            return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
          },
          async run() {
            return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
          },
        };
      },
    };
  }
  return {
    prepare,
    async batch(statements: { sql: string; values: SQLInputValue[] }[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, values }) => ({
          meta: {
            changes: Number(sqlite.prepare(sql).run(...values).changes),
          },
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const origin = "https://dev.dontneeda.pw";
const browserBinding = "A".repeat(43);
describe("unconnected real verifier to atomic storage flow (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let flow: ReturnType<typeof createPasskeyFlow>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T20:00:00Z"));
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      `PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,email_verified INTEGER NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',banned_at TEXT);`,
    );
    sqlite.exec(
      readFileSync(
        new URL("../../../../docs/proposals/passkey-schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db = d1Adapter(sqlite);
    flow = createPasskeyFlow(db, origin);
  });
  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });
  async function enrollment() {
    const delivery = (await createEmailSignupIntent(db, {
      browserBinding,
      idpOrigin: origin,
      email: "synthetic@example.test",
    }))!;
    await claimEmailSignupDelivery(db, { ...delivery, browserBinding, idpOrigin: origin });
    const proof = (await verifyEmailSignupIntent(db, {
      ...delivery,
      browserBinding,
      idpOrigin: origin,
    }))!;
    const authority = {
      browserBinding,
      intentId: proof.id,
      authority: proof.authority,
      userName: "Synthetic",
    };
    const issued = (await flow.registrationOptions(authority))!;
    const response = structuredClone(attestationNone);
    const client = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON));
    response.response.clientDataJSON = isoBase64URL.fromUTF8String(
      JSON.stringify({ ...client, challenge: issued.options.challenge }),
    );
    return { authority, issued, response };
  }
  async function authentication() {
    const fixture = await syntheticAuthenticator();
    sqlite
      .prepare("INSERT INTO users(id,email,email_verified,name) VALUES(?,?,1,'Synthetic')")
      .run(fixture.snapshot.ownerID, "synthetic@example.test");
    sqlite
      .prepare("INSERT INTO passkey_user_handles(user_id,webauthn_user_id) VALUES(?,?)")
      .run(fixture.snapshot.ownerID, fixture.stored.webAuthnUserID);
    const row = (await storeVerifiedPasskey(db, {
      credentialId: fixture.stored.credential.id,
      userId: fixture.snapshot.ownerID,
      publicKey: isoBase64URL.fromBuffer(fixture.stored.credential.publicKey),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    }))!;
    const input = { browserBinding, userId: fixture.snapshot.ownerID };
    const issued = (await flow.authenticationOptions(input))!;
    Object.assign(fixture.snapshot, { challenge: issued.options.challenge });
    return { fixture, row, input, issued, response: await fixture.assertion(1) };
  }
  it("connects verified email, actual UP+UV registration and atomic account/key/handle creation", async () => {
    const { authority, issued, response } = await enrollment();
    expect(JSON.stringify(issued)).not.toContain(authority.authority);
    expect(JSON.stringify(issued)).not.toContain(browserBinding);
    expect(sqlite.prepare("SELECT count(*) n FROM users").get()?.n).toBe(0);
    const result = await flow.completeRegistration({
      ...authority,
      pendingId: issued.pendingId,
      name: "Synthetic",
      response,
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected fixture registration");
    expect(
      sqlite.prepare("SELECT email,email_verified,role FROM users WHERE id=?").get(result.userId),
    ).toEqual({ email: "synthetic@example.test", email_verified: 1, role: "user" });
    const key = sqlite
      .prepare("SELECT public_key,user_id,registration_id FROM passkey_credentials")
      .get()!;
    expect(key.user_id).toBe(result.userId);
    expect(key.registration_id).toBe(result.receipt.registrationId);
    expect(key.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      sqlite.prepare("SELECT webauthn_user_id FROM passkey_user_handles").get()?.webauthn_user_id,
    ).toBe(issued.options.user.id);
    expect(
      (
        await flow.completeRegistration({
          ...authority,
          pendingId: issued.pendingId,
          name: "Synthetic",
          response,
        })
      ).status,
    ).toBe("not_created");
    expect(sqlite.prepare("SELECT count(*) n FROM users").get()?.n).toBe(1);
  });
  it("resumes identical options after a lost response without reissuing email or replacing the challenge", async () => {
    const { authority, issued } = await enrollment();
    const resumed = await flow.registrationOptions(authority);
    expect(resumed?.pendingId).toBe(issued.pendingId);
    expect(resumed?.options.challenge).toBe(issued.options.challenge);
    expect(resumed?.options.user.id).toBe(issued.options.user.id);
    expect(sqlite.prepare("SELECT count(*) n FROM passkey_signup_pending").get()?.n).toBe(1);
    expect(await flow.registrationOptions({ ...authority, pendingId: "wrong-id" })).toBeNull();
    expect(await flow.registrationOptions({ ...authority, authority: "B".repeat(43) })).toBeNull();
  });

  it("does not create a user or spend authority for wrong challenge/browser/proof", async () => {
    const { authority, issued, response } = await enrollment();
    for (const override of [{ browserBinding: "B".repeat(43) }, { authority: "B".repeat(43) }]) {
      expect(
        (
          await flow.completeRegistration({
            ...authority,
            ...override,
            pendingId: issued.pendingId,
            name: "Synthetic",
            response,
          })
        ).status,
      ).toBe("not_created");
    }
    const bad = structuredClone(response);
    bad.response.clientDataJSON = isoBase64URL.fromUTF8String(
      JSON.stringify({
        ...JSON.parse(isoBase64URL.toUTF8String(bad.response.clientDataJSON)),
        challenge: "B".repeat(43),
      }),
    );
    expect(
      (
        await flow.completeRegistration({
          ...authority,
          pendingId: issued.pendingId,
          name: "Synthetic",
          response: bad,
        })
      ).status,
    ).toBe("not_created");
    expect(sqlite.prepare("SELECT count(*) n FROM users").get()?.n).toBe(0);
    expect(
      sqlite.prepare("SELECT consumed_at FROM email_signup_intents").get()?.consumed_at,
    ).toBeNull();
    expect(
      (
        await flow.completeRegistration({
          ...authority,
          pendingId: issued.pendingId,
          name: "Synthetic",
          response,
        })
      ).status,
    ).toBe("created");
  });
  it("cannot issue registration options without a verified email authority", async () => {
    expect(
      await flow.registrationOptions({
        browserBinding,
        intentId: "missing",
        authority: "B".repeat(43),
        userName: "Synthetic",
      }),
    ).toBeNull();
    expect(sqlite.prepare("SELECT count(*) n FROM passkey_signup_pending").get()?.n).toBe(0);
  });
  it("connects actual signed UP+UV assertion to one challenge claim and persisted counter", async () => {
    const { input, issued, response } = await authentication();
    expect(
      await flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
    ).toEqual({ verified: true, userId: input.userId });
    expect(sqlite.prepare("SELECT sign_count FROM passkey_credentials").get()?.sign_count).toBe(1);
    expect(
      await flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
    ).toEqual({ verified: false });
  });
  it("allows only one parallel completion of one signed assertion", async () => {
    const { input, issued, response } = await authentication();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
      ),
    );
    expect(results.filter((r) => r.verified)).toHaveLength(1);
  });
  it("does not consume a challenge for wrong browser, handle, ID or absent UV", async () => {
    const { fixture, input, issued, response } = await authentication();
    expect(
      await flow.authenticate({
        ...input,
        browserBinding: "B".repeat(43),
        challengeId: issued.challengeId,
        response,
      }),
    ).toEqual({ verified: false });
    for (const bad of [
      { ...response, id: "wrong-id" },
      { ...response, response: { ...response.response, userHandle: "B".repeat(43) } },
      await fixture.assertion(1, 1),
    ]) {
      expect(
        await flow.authenticate({ ...input, challengeId: issued.challengeId, response: bad }),
      ).toEqual({ verified: false });
    }
    expect(sqlite.prepare("SELECT count(*) n FROM passkey_challenges").get()?.n).toBe(1);
    expect(
      await flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
    ).toEqual({ verified: true, userId: input.userId });
  });
  it.each(["banned_at='2026-11-07'", "email_verified=0"])(
    "rejects a status change after challenge issue: %s",
    async (change) => {
      const { input, issued, response } = await authentication();
      sqlite.exec(`UPDATE users SET ${change}`);
      expect(
        await flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
      ).toEqual({ verified: false });
      expect(await flow.authenticationOptions(input)).toBeNull();
    },
  );
  it("rejects a credential generation changed after signature verification", async () => {
    const { input, issued, response } = await authentication();
    const prepare = db.prepare.bind(db);
    let changed = false;
    const interleaved = {
      batch: db.batch.bind(db),
      prepare(sql: string) {
        if (sql.includes("DELETE FROM passkey_challenges") && !changed) {
          changed = true;
          sqlite.exec("UPDATE passkey_credentials SET registration_id='replacement-generation'");
        }
        return prepare(sql);
      },
    } as unknown as D1Database;
    expect(
      await createPasskeyFlow(interleaved, origin).authenticate({
        ...input,
        challengeId: issued.challengeId,
        response,
      }),
    ).toEqual({ verified: false });
    expect(changed).toBe(true);
    expect(sqlite.prepare("SELECT sign_count FROM passkey_credentials").get()?.sign_count).toBe(0);
  });
  it("rejects an expired authentication challenge before granting a proof", async () => {
    const { input, issued, response } = await authentication();
    vi.advanceTimersByTime(300_000);
    expect(
      await flow.authenticate({ ...input, challengeId: issued.challengeId, response }),
    ).toEqual({ verified: false });
  });
});
