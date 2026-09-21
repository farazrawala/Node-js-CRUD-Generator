/**
 * Daraz Pakistan token helper unit tests (no DB / live Daraz network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DARAZ_PK_REST_BASE,
  DARAZ_PK_AUTHORIZE_BASE,
  DARAZ_PK_DEFAULT_CALLBACK,
  CREATE_TOKEN_PATH,
  REFRESH_TOKEN_PATH,
  signDarazRequest,
  buildDarazAuthorizeUrl,
  buildDarazRequest,
  tokenPatchFromDarazPayload,
  publicTokenResult,
  resolveDarazTokenAction,
  extractDarazSellerCode,
  isDarazCallbackUrlWithoutCode,
  createDarazAccessToken,
  refreshDarazAccessToken,
} = require("../utils/darazTokenRefresh");

describe("darazTokenRefresh signing", () => {
  it("matches the official HMAC-SHA256 sample vector", () => {
    const sign = signDarazRequest(
      "/order/get",
      {
        access_token: "test",
        app_key: "123456",
        order_id: "1234",
        sign_method: "sha256",
        timestamp: "1517820392000",
      },
      "helloworld",
    );
    assert.equal(
      sign,
      "4190D32361CFB9581350222F345CB77F3B19F0E31D162316848A2C1FFD5FAB4A",
    );
  });

  it("excludes the sign field from the digest", () => {
    const withoutSign = signDarazRequest(
      "/auth/token/refresh",
      { app_key: "1", refresh_token: "abc", timestamp: "2", sign_method: "sha256" },
      "secret",
    );
    const withSign = signDarazRequest(
      "/auth/token/refresh",
      {
        app_key: "1",
        refresh_token: "abc",
        timestamp: "2",
        sign_method: "sha256",
        sign: "SHOULD_BE_IGNORED",
      },
      "secret",
    );
    assert.equal(withoutSign, withSign);
  });
});

describe("darazTokenRefresh Pakistan gateway", () => {
  it("builds the PK authorize URL", () => {
    const url = buildDarazAuthorizeUrl({
      appKey: "APPKEY",
      redirectUri: "https://pos.example.com/daraz/callback",
      state: "abc",
    });
    assert.ok(url.startsWith(`${DARAZ_PK_AUTHORIZE_BASE}?`));
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("client_id"), "APPKEY");
    assert.equal(parsed.searchParams.get("force_auth"), "true");
    assert.equal(parsed.searchParams.get("state"), "abc");
  });

  it("posts refresh to api.daraz.pk/rest only", () => {
    const request = buildDarazRequest({
      apiPath: REFRESH_TOKEN_PATH,
      appKey: "APPKEY",
      appSecret: "APPSECRET",
      apiParams: { refresh_token: "rt-1" },
      timestamp: "1710000000000",
    });
    assert.ok(request.url.startsWith(`${DARAZ_PK_REST_BASE}${REFRESH_TOKEN_PATH}?`));
    assert.equal(request.apiParams.refresh_token, "rt-1");
    assert.match(request.body, /refresh_token=rt-1/);
    assert.doesNotMatch(request.url, /daraz\.com\.bd|daraz\.lk/);
  });
});

describe("darazTokenRefresh token calls", () => {
  it("creates a token via /auth/token/create", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at-new",
            refresh_token: "rt-new",
            expires_in: 3600,
            refresh_expires_in: 86400,
            account: "seller@example.com",
          }),
      };
    };

    const result = await createDarazAccessToken({
      appKey: "APPKEY",
      appSecret: "APPSECRET",
      code: "0_abc",
      fetchImpl,
    });

    assert.equal(result.access_token, "at-new");
    assert.equal(result.refresh_token, "rt-new");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(`${DARAZ_PK_REST_BASE}${CREATE_TOKEN_PATH}?`));
    assert.equal(calls[0].options.method, "POST");
    assert.match(calls[0].options.body, /code=0_abc/);
  });

  it("refreshes a token via /auth/token/refresh", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 100,
        }),
    });

    const result = await refreshDarazAccessToken({
      appKey: "APPKEY",
      appSecret: "APPSECRET",
      refreshToken: "rt-1",
      fetchImpl,
    });

    assert.equal(result.access_token, "at-2");
    assert.equal(result.refresh_token, "rt-2");
  });

  it("masks tokens in the public payload", () => {
    const publicData = publicTokenResult({
      access_token: "50000601c30atokenXYZ",
      refresh_token: "500016000300refreshABC",
      expires_in: 60,
    });
    assert.equal(publicData.country, "pk");
    assert.equal(publicData.gateway, DARAZ_PK_REST_BASE);
    assert.equal(publicData.access_token_masked, "500006…nXYZ");
    assert.equal(publicData.refresh_expires_in, 86400);
    assert.doesNotMatch(publicData.access_token_masked, /tokenXYZ$/);
  });

  it("builds a mongo patch from Daraz payload", () => {
    const fromDate = new Date("2026-09-21T00:00:00.000Z");
    const patch = tokenPatchFromDarazPayload(
      {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 60,
        refresh_expires_in: 120,
      },
      fromDate,
    );
    assert.equal(patch.token, "at");
    assert.equal(patch.refresh_token, "rt");
    assert.equal(patch.token_expiry.toISOString(), "2026-09-21T00:01:00.000Z");
    assert.equal(
      patch.refresh_token_expiry.toISOString(),
      "2026-09-22T00:00:00.000Z",
    );
  });
});

describe("darazTokenRefresh POS refresh button inputs", () => {
  it("uses stored refresh_token when present", () => {
    const resolved = resolveDarazTokenAction({
      storedRefreshToken: "rt-stored",
      storedAccessToken: "at-stored",
    });
    assert.equal(resolved.action, "refresh");
    assert.equal(resolved.refreshToken, "rt-stored");
  });

  it("falls back to token field as refresh_token", () => {
    const resolved = resolveDarazTokenAction({
      storedAccessToken: "500016000300refreshABC",
    });
    assert.equal(resolved.action, "refresh");
    assert.equal(resolved.refreshToken, "500016000300refreshABC");
  });

  it("treats 0_ seller code in Token as generate, even if refresh_token exists", () => {
    const resolved = resolveDarazTokenAction({
      storedRefreshToken: "rt-stored",
      storedAccessToken: "0_TryzT8Vd9T1pwS7VWZ2qlMOS5",
    });
    assert.equal(resolved.action, "create");
    assert.equal(resolved.code, "0_TryzT8Vd9T1pwS7VWZ2qlMOS5");
  });

  it("treats 0_ auth codes in token as generate", () => {
    const resolved = resolveDarazTokenAction({
      storedAccessToken: "0_TryzT8Vd9T1pwS7VWZ2qlMOS5",
    });
    assert.equal(resolved.action, "create");
    assert.equal(resolved.code, "0_TryzT8Vd9T1pwS7VWZ2qlMOS5");
  });

  it("extracts 0_ seller code from a callback URL pasted into Token", () => {
    const resolved = resolveDarazTokenAction({
      storedAccessToken:
        "https://pos.example.com/daraz/callback?code=0_TryzT8Vd9T1pwS7VWZ2qlMOS5&state=abc",
    });
    assert.equal(resolved.action, "create");
    assert.equal(resolved.code, "0_TryzT8Vd9T1pwS7VWZ2qlMOS5");
  });

  it("tells the user to paste a 0_ seller code when nothing is stored", () => {
    const resolved = resolveDarazTokenAction({});
    assert.equal(resolved.action, "missing");
    assert.match(resolved.message, /seller code/i);
  });

  it("extracts live 4_ seller code from the PHP webhook redirect URL", () => {
    const liveUrl =
      "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz&code=4_506036_3noVuczkkjDMtVNti33rJzQQ582";
    const resolved = resolveDarazTokenAction({
      storedAccessToken: liveUrl,
    });
    assert.equal(resolved.action, "create");
    assert.equal(resolved.code, "4_506036_3noVuczkkjDMtVNti33rJzQQ582");
    assert.equal(extractDarazSellerCode(liveUrl), "4_506036_3noVuczkkjDMtVNti33rJzQQ582");
  });

  it("extracts 4_ seller code from webhook.php JSON capture", () => {
    const code = extractDarazSellerCode(
      JSON.stringify({
        success: true,
        message: "Webhook received and email sent.",
        captured: {
          query_string:
            "callback=daraz&code=4_506036_3noVuczkkjDMtVNti33rJzQQ582",
        },
      }),
    );
    assert.equal(code, "4_506036_3noVuczkkjDMtVNti33rJzQQ582");
  });

  it("extracts 0_ seller code from the PHP webhook callback URL", () => {
    const resolved = resolveDarazTokenAction({
      storedAccessToken:
        "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback&code=0_TryzT8Vd9T1pwS7VWZ2qlMOS5",
    });
    assert.equal(resolved.action, "create");
    assert.equal(resolved.code, "0_TryzT8Vd9T1pwS7VWZ2qlMOS5");
  });

  it("extracts 0_ seller code from webhook.php JSON capture", () => {
    const code = extractDarazSellerCode(
      JSON.stringify({
        success: true,
        captured: { query_string: "callback&code=0_TryzT8Vd9T1pwS7VWZ2qlMOS5" },
      }),
    );
    assert.equal(code, "0_TryzT8Vd9T1pwS7VWZ2qlMOS5");
  });

  it("rejects the webhook URL when it has no code=", () => {
    assert.equal(
      isDarazCallbackUrlWithoutCode(
        "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?hello=test",
      ),
      true,
    );
    assert.equal(
      extractDarazSellerCode(
        "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?hello=test",
      ),
      null,
    );
  });

  it("uses the registered PHP webhook as the default redirect_uri", () => {
    assert.equal(
      DARAZ_PK_DEFAULT_CALLBACK,
      "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz",
    );
    const url = buildDarazAuthorizeUrl({
      appKey: "506036",
      redirectUri: DARAZ_PK_DEFAULT_CALLBACK,
      state: "6ab05e265ea3a97a9977e51a",
    });
    const parsed = new URL(url);
    assert.equal(
      parsed.searchParams.get("redirect_uri"),
      DARAZ_PK_DEFAULT_CALLBACK,
    );
    assert.equal(parsed.searchParams.get("client_id"), "506036");
  });
});
