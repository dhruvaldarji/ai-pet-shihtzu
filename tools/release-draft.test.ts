import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { releaseAssetNames, releaseZipName, type ValidatedRelease } from "./release";
import { createDraftRelease } from "./release-draft";

const VERSION = "v1.0.0";
const ZIP_NAME = releaseZipName(VERSION);
const ZIP_BYTES = Buffer.from(`verified:${ZIP_NAME}`);
const ZIP_SHA = createHash("sha256").update(ZIP_BYTES).digest("hex");
const RELEASE_ASSET_NAMES = releaseAssetNames(VERSION);
const SOURCE = "a".repeat(40);
const OTHER_SOURCE = "c".repeat(40);
const ATLAS_HASH = "d".repeat(64);
const TOKEN = "synthetic-test-token";
const RELEASE_ID = 73;
const UPLOAD_URL = `https://uploads.github.com/repos/dhruvaldarji/ai-pet-shihtzu/releases/${RELEASE_ID}/assets{?name,label}`;
const CONTEXT = {
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  repository: "dhruvaldarji/ai-pet-shihtzu",
};

function artifact(): ValidatedRelease {
  const files = new Map(RELEASE_ASSET_NAMES.map((name) => [name, Buffer.from(`verified:${name}`)]));
  return {
    directory: "synthetic-release-directory",
    manifest: {
      version: VERSION,
      sourceCommit: SOURCE,
      atlasSha256: ATLAS_HASH,
      assets: RELEASE_ASSET_NAMES.filter((name) => name !== "release.json" && name !== "SHA256SUMS")
        .map((name) => ({
          name,
          url: `https://example.invalid/${name}`,
          sha256: name === ZIP_NAME ? ZIP_SHA : "b".repeat(64),
          size: files.get(name)?.length ?? 0,
        })),
    } as ValidatedRelease["manifest"],
    files,
  };
}

function artifactBytes(name: string) {
  const bytes = artifact().files.get(name);
  if (!bytes) throw new Error("Synthetic release asset is missing");
  return bytes;
}

const validateDirectory = async (
  _directory: string,
  expected: {
    version?: string;
    sourceCommit?: string;
    atlasSha256?: string;
    softwareLicenseSha256?: string;
    artworkLicenseSha256?: string;
  } = {},
) => {
  if (
    expected.version !== VERSION ||
    expected.sourceCommit !== SOURCE ||
    expected.atlasSha256 !== ATLAS_HASH ||
    expected.softwareLicenseSha256 !== "e".repeat(64) ||
    expected.artworkLicenseSha256 !== "f".repeat(64)
  )
    throw new Error("Test release binding mismatch");
  return artifact();
};
const validateSourceBinding = async (_root: string, source: string) => {
  if (source !== SOURCE) throw new Error("Test source binding mismatch");
  return {
    sourceCommit: SOURCE,
    atlasSha256: ATLAS_HASH,
    softwareLicenseSha256: "e".repeat(64),
    artworkLicenseSha256: "f".repeat(64),
  };
};

type Mode = "new" | "draft" | "published";
type MockOptions = {
  mode?: Mode;
  initialAssets?: string[];
  assetOverrides?: Map<string, Buffer>;
  starterAsset?: string;
  protectedEnvironment?: boolean;
  uploadUrl?: string;
  resolvedCommit?: string;
  targetCommitish?: string;
  tagExists?: boolean;
  secondPageDraft?: boolean;
  duplicateDrafts?: boolean;
  redirectOnce?: string;
};
type Call = {
  url: URL;
  method: string;
  headers: Headers;
  body?: RequestInit["body"];
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function missing() {
  return new Response("private server diagnostic", { status: 404 });
}

function mockGitHub(options: MockOptions = {}) {
  const mode = options.mode ?? "new";
  const calls: Call[] = [];
  const remoteAssets = new Map<
    number,
    { id: number; name: string; size: number; state: "uploaded" | "starter"; bytes: Buffer }
  >();
  let nextAssetId = 1;
  const tagExists = options.tagExists ?? mode === "published";
  let redirected = false;
  let redirectedAssetId = 0;
  let release =
    mode === "new"
      ? null
      : {
          id: RELEASE_ID,
          tag_name: VERSION,
          draft: mode === "draft",
          target_commitish: options.targetCommitish ?? SOURCE,
          upload_url: options.uploadUrl ?? UPLOAD_URL,
        };
  const listedReleases = () => {
    if (!release) return [];
    if (options.secondPageDraft) {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        ...release,
        id: RELEASE_ID + index + 1,
        tag_name: `v0.${index}.0`,
      }));
      return { firstPage, secondPage: [release] };
    }
    if (options.duplicateDrafts) return [release, { ...release, id: RELEASE_ID + 1 }];
    return [release];
  };

  for (const name of options.initialAssets ?? []) {
    const expected = artifact().files.get(name);
    const bytes =
      options.assetOverrides?.get(name) ?? expected ?? Buffer.from(`unexpected:${name}`);
    const id = nextAssetId++;
    remoteAssets.set(id, {
      id,
      name,
      size: bytes.length,
      state: options.starterAsset === name ? "starter" : "uploaded",
      bytes,
    });
  }

  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof Request ? input.url : input,
    );
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: new Headers(init.headers), body: init.body });

    if (url.hostname === "uploads.github.com" && method === "POST") {
      const name = url.searchParams.get("name") ?? "";
      const bytes = Buffer.from(init.body as Uint8Array);
      const id = nextAssetId++;
      const asset = { id, name, size: bytes.length, state: "uploaded" as const, bytes };
      remoteAssets.set(id, asset);
      return json({ id, name, size: bytes.length, state: "uploaded" });
    }
    if (
      options.redirectOnce &&
      url.hostname === new URL(options.redirectOnce).hostname &&
      url.hostname !== "api.github.com"
    ) {
      const asset = remoteAssets.get(redirectedAssetId);
      return asset ? new Response(asset.bytes) : missing();
    }

    const prefix = "/repos/dhruvaldarji/ai-pet-shihtzu";
    if (url.pathname === `${prefix}/environments/release-approval`)
      return json({
        protection_rules:
          options.protectedEnvironment === false
            ? []
            : [{ type: "required_reviewers", reviewers: [{ type: "User", id: 1 }] }],
      });
    if (url.pathname === `${prefix}/releases/tags/${VERSION}`)
      return release && !release.draft && tagExists ? json(release) : missing();
    if (url.pathname === `${prefix}/releases` && method === "GET") {
      const page = Number(url.searchParams.get("page"));
      const listed = listedReleases();
      if (!Array.isArray(listed)) return json(page === 1 ? listed.firstPage : listed.secondPage);
      return json(listed);
    }
    if (url.pathname === `${prefix}/git/ref/tags/${VERSION}`) {
      return tagExists
        ? json({ ref: `refs/tags/${VERSION}`, object: { sha: "b".repeat(40), type: "tag" } })
        : missing();
    }
    if (url.pathname === `${prefix}/commits/${VERSION}`)
      return tagExists ? json({ sha: options.resolvedCommit ?? SOURCE }) : missing();
    if (url.pathname === `${prefix}/releases` && method === "POST") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      release = {
        id: RELEASE_ID,
        tag_name: String(payload.tag_name),
        draft: payload.draft === true,
        target_commitish: String(payload.target_commitish),
        upload_url: options.uploadUrl ?? UPLOAD_URL,
      };
      return json(release);
    }
    if (url.pathname === `${prefix}/releases/${RELEASE_ID}/assets`)
      return json(
        [...remoteAssets.values()].map(({ id, name, size, state }) => ({ id, name, size, state })),
      );
    const assetMatch = new RegExp(`^${prefix}/releases/assets/(\\d+)$`).exec(url.pathname);
    if (assetMatch && method === "GET") {
      const id = Number(assetMatch[1]);
      const asset = remoteAssets.get(id);
      if (!asset) return missing();
      if (options.redirectOnce && !redirected) {
        redirected = true;
        redirectedAssetId = id;
        return new Response(null, { status: 302, headers: { Location: options.redirectOnce } });
      }
      return new Response(asset.bytes);
    }
    throw new Error("Unexpected synthetic GitHub request");
  };

  return { calls, fetcher };
}

function options(directory = "synthetic-release-directory") {
  return { version: VERSION, source: SOURCE, directory, token: TOKEN, context: CONTEXT };
}

function dependencies(api: ReturnType<typeof mockGitHub>) {
  return { fetcher: api.fetcher, validateDirectory, validateSourceBinding };
}

test("invalid release artifacts fail before any GitHub request", async () => {
  const api = mockGitHub();
  await expect(
    createDraftRelease(options("missing-artifact"), {
      fetcher: api.fetcher,
      validateSourceBinding,
    }),
  ).rejects.toThrow();
  expect(api.calls).toHaveLength(0);
});

test("manual main-branch and protected-reviewer gates fail before release writes", async () => {
  const wrongContextApi = mockGitHub();
  await expect(
    createDraftRelease(
      { ...options(), context: { ...CONTEXT, ref: "refs/heads/feature" } },
      dependencies(wrongContextApi),
    ),
  ).rejects.toThrow("canonical manual main-branch workflow");
  expect(wrongContextApi.calls).toHaveLength(0);

  const unprotectedApi = mockGitHub({ protectedEnvironment: false });
  await expect(createDraftRelease(options(), dependencies(unprotectedApi))).rejects.toThrow(
    "owner reviewer",
  );
  expect(unprotectedApi.calls.some((call) => call.method === "POST")).toBe(false);
  expect(
    unprotectedApi.calls.some(
      (call) => call.url.pathname.endsWith(`/releases/tags/${VERSION}`),
    ),
  ).toBe(false);
});

test("new release creates a draft and uploads only raw allowlisted assets", async () => {
  const api = mockGitHub();
  await expect(createDraftRelease(options(), dependencies(api))).resolves.toEqual({
    state: "created",
  });
  const releasePosts = api.calls.filter(
    (call) => call.method === "POST" && call.url.pathname.endsWith("/releases"),
  );
  expect(releasePosts).toHaveLength(1);
  expect(JSON.parse(String(releasePosts[0].body))).toEqual({
    tag_name: VERSION,
    target_commitish: SOURCE,
    name: `Louis ${VERSION}`,
    body: [
      "Verified source-bound draft. Not published.",
      `Package: ${ZIP_NAME}`,
      `SHA256: ${ZIP_SHA}`,
      `Source commit: ${SOURCE}`,
      "Native playback and direct installation: unverified.",
    ].join("\n"),
    draft: true,
    prerelease: false,
    make_latest: "false",
  });
  const uploads = api.calls.filter(
    (call) => call.method === "POST" && call.url.hostname === "uploads.github.com",
  );
  expect(uploads.map((call) => call.url.searchParams.get("name"))).toEqual([
    ...RELEASE_ASSET_NAMES,
  ]);
  const assetPages = api.calls.filter(
    (call) =>
      call.url.hostname === "api.github.com" && call.url.pathname.endsWith("/releases/73/assets"),
  );
  expect(assetPages.length).toBeGreaterThan(0);
  expect(assetPages.every((call) => call.url.searchParams.get("per_page") === "100")).toBe(true);
  expect(
    uploads.every(
      (call) =>
        call.url.pathname === `${new URL(UPLOAD_URL.slice(0, -"{?name,label}".length)).pathname}`,
    ),
  ).toBe(true);
  for (const upload of uploads) {
    const name = upload.url.searchParams.get("name");
    if (!name) throw new Error("Synthetic upload name is missing");
    const bytes = artifactBytes(name);
    expect(upload.headers.get("content-type")).toBe("application/octet-stream");
    expect(upload.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(upload.body as Uint8Array).equals(bytes)).toBe(true);
  }
  expect(api.calls.some((call) => call.method === "PATCH" || call.method === "DELETE")).toBe(false);
  expect(uploads.some((call) => call.url.searchParams.get("name") === "latest.json")).toBe(false);
});

test("new draft creation fails closed without versioned ZIP metadata", async () => {
  const api = mockGitHub();
  const incomplete = artifact();
  incomplete.manifest.assets = incomplete.manifest.assets.filter((asset) => asset.name !== ZIP_NAME);
  await expect(
    createDraftRelease(options(), {
      ...dependencies(api),
      validateDirectory: async () => incomplete,
    }),
  ).rejects.toThrow("Verified release ZIP metadata is missing");
  expect(api.calls.some((call) => call.method === "POST")).toBe(false);
});

test("a matching draft resumes only missing assets after verifying existing bytes", async () => {
  const api = mockGitHub({ mode: "draft", initialAssets: [ZIP_NAME] });
  await expect(createDraftRelease(options(), dependencies(api))).resolves.toEqual({
    state: "resumed",
  });
  const uploads = api.calls.filter(
    (call) => call.method === "POST" && call.url.hostname === "uploads.github.com",
  );
  expect(uploads).toHaveLength(RELEASE_ASSET_NAMES.length - 1);
  expect(uploads.some((call) => call.url.searchParams.get("name") === ZIP_NAME)).toBe(false);
  expect(
    api.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/git/refs")),
  ).toBe(false);

  await expect(createDraftRelease(options(), dependencies(api))).resolves.toEqual({
    state: "resumed",
  });
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && call.url.hostname === "uploads.github.com",
    ),
  ).toHaveLength(RELEASE_ASSET_NAMES.length - 1);
});

test("a draft found on the second releases page resumes without a tag or duplicate create", async () => {
  const api = mockGitHub({ mode: "draft", secondPageDraft: true, initialAssets: [ZIP_NAME] });
  await expect(createDraftRelease(options(), dependencies(api))).resolves.toEqual({
    state: "resumed",
  });
  expect(
    api.calls.some(
      (call) =>
        call.url.pathname.endsWith("/releases") && call.url.searchParams.get("page") === "2",
    ),
  ).toBe(true);
  expect(
    api.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/releases")),
  ).toBe(false);
  expect(
    api.calls.some((call) => call.method === "POST" && call.url.pathname.endsWith("/git/refs")),
  ).toBe(false);
});

test("changed existing assets fail before an upload or release mutation", async () => {
  const expected = artifactBytes(ZIP_NAME);
  const changed = Buffer.from(expected);
  changed[0] = changed[0] === 120 ? 121 : 120;
  const overrides = new Map([[ZIP_NAME, changed]]);
  const api = mockGitHub({
    mode: "draft",
    initialAssets: [ZIP_NAME],
    assetOverrides: overrides,
  });
  await expect(createDraftRelease(options(), dependencies(api))).rejects.toThrow(
    "differs from the verified artifact",
  );
  expect(
    api.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);
});

test("published releases are no-op only when every asset matches", async () => {
  const complete = mockGitHub({ mode: "published", initialAssets: [...RELEASE_ASSET_NAMES] });
  await expect(createDraftRelease(options(), dependencies(complete))).resolves.toEqual({
    state: "published-unchanged",
  });
  expect(
    complete.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);

  const incomplete = mockGitHub({ mode: "published", initialAssets: [ZIP_NAME] });
  await expect(createDraftRelease(options(), dependencies(incomplete))).rejects.toThrow(
    "missing immutable assets",
  );
  expect(
    incomplete.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);

  const changedBytes = Buffer.from(artifactBytes(ZIP_NAME));
  changedBytes[0] = changedBytes[0] === 120 ? 121 : 120;
  const changed = mockGitHub({
    mode: "published",
    initialAssets: [ZIP_NAME],
    assetOverrides: new Map([[ZIP_NAME, changedBytes]]),
  });
  await expect(createDraftRelease(options(), dependencies(changed))).rejects.toThrow(
    "differs from the verified artifact",
  );
  expect(
    changed.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);
});

test("tag source mismatch and unsafe upload endpoints fail closed", async () => {
  const wrongTag = mockGitHub({ mode: "draft", tagExists: true, resolvedCommit: OTHER_SOURCE });
  await expect(createDraftRelease(options(), dependencies(wrongTag))).rejects.toThrow(
    "another source commit",
  );
  expect(wrongTag.calls.some((call) => call.method === "POST")).toBe(false);

  const conflictingPublishedTag = mockGitHub({
    mode: "published",
    resolvedCommit: OTHER_SOURCE,
  });
  await expect(
    createDraftRelease(options(), dependencies(conflictingPublishedTag)),
  ).rejects.toThrow("another source commit");
  expect(conflictingPublishedTag.calls.some((call) => call.method === "POST")).toBe(false);

  const missingTag = mockGitHub({ mode: "published", tagExists: false });
  await expect(createDraftRelease(options(), dependencies(missingTag))).rejects.toThrow(
    "Existing published release is missing its Git tag",
  );
  expect(missingTag.calls.some((call) => call.method === "POST")).toBe(false);

  const wrongDraftSource = mockGitHub({ mode: "draft", targetCommitish: OTHER_SOURCE });
  await expect(createDraftRelease(options(), dependencies(wrongDraftSource))).rejects.toThrow(
    "targets another source commit",
  );
  expect(wrongDraftSource.calls.some((call) => call.method === "POST")).toBe(false);

  const unsafeUpload = mockGitHub({
    uploadUrl: "https://attacker.example/releases/73/assets{?name,label}",
  });
  await expect(createDraftRelease(options(), dependencies(unsafeUpload))).rejects.toThrow(
    "canonical repository endpoint",
  );
  expect(unsafeUpload.calls.some((call) => call.url.hostname === "attacker.example")).toBe(false);
  expect(unsafeUpload.calls.some((call) => call.url.hostname === "uploads.github.com")).toBe(false);
});

test("unknown and duplicate release assets fail closed", async () => {
  const unknown = mockGitHub({ mode: "draft", initialAssets: ["unexpected.txt"] });
  await expect(createDraftRelease(options(), dependencies(unknown))).rejects.toThrow(
    "unexpected or duplicate asset",
  );
  expect(unknown.calls.some((call) => call.method === "POST")).toBe(false);

  const duplicate = mockGitHub({ mode: "draft", initialAssets: [ZIP_NAME, ZIP_NAME] });
  await expect(createDraftRelease(options(), dependencies(duplicate))).rejects.toThrow(
    "unexpected or duplicate asset",
  );
  expect(duplicate.calls.some((call) => call.method === "POST")).toBe(false);
});

test("starter assets are rejected before uploads or other mutations", async () => {
  const starter = mockGitHub({
    mode: "draft",
    initialAssets: [ZIP_NAME],
    starterAsset: ZIP_NAME,
  });
  await expect(createDraftRelease(options(), dependencies(starter))).rejects.toThrow(
    "release asset metadata is invalid",
  );
  expect(
    starter.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);
});

test("duplicate matching drafts fail before any mutation", async () => {
  const duplicateDrafts = mockGitHub({ mode: "draft", duplicateDrafts: true });
  await expect(createDraftRelease(options(), dependencies(duplicateDrafts))).rejects.toThrow(
    "Multiple GitHub releases match this version",
  );
  expect(
    duplicateDrafts.calls.some(
      (call) => call.method === "POST" || call.method === "PATCH" || call.method === "DELETE",
    ),
  ).toBe(false);
});

test("asset redirects reject arbitrary hosts and omit credentials on GitHub redirects", async () => {
  const unsafe = mockGitHub({
    mode: "published",
    initialAssets: [ZIP_NAME],
    redirectOnce: "https://attacker.example/private-asset",
  });
  await expect(createDraftRelease(options(), dependencies(unsafe))).rejects.toThrow(
    "redirect target is not trusted",
  );
  expect(unsafe.calls.some((call) => call.url.hostname === "attacker.example")).toBe(false);

  const safe = mockGitHub({
    mode: "published",
    initialAssets: [...RELEASE_ASSET_NAMES],
    redirectOnce: "https://release-assets.githubusercontent.com/signed-object?token=synthetic",
  });
  await expect(createDraftRelease(options(), dependencies(safe))).resolves.toEqual({
    state: "published-unchanged",
  });
  const external = safe.calls.find(
    (call) => call.url.hostname === "release-assets.githubusercontent.com",
  );
  expect(external?.headers.has("authorization")).toBe(false);
  expect(external?.url.searchParams.get("token")).toBe("synthetic");
});

test("GitHub API failures do not expose response bodies or credentials", async () => {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: new URL(
        typeof input === "string" ? input : input instanceof Request ? input.url : input,
      ),
      method: (init.method ?? "GET").toUpperCase(),
      headers: new Headers(init.headers),
      body: init.body,
    });
    return new Response("private-token-response-body", { status: 500 });
  };
  let message = "";
  try {
    await createDraftRelease(options(), { validateDirectory, validateSourceBinding, fetcher });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toBe("GitHub API request failed");
  expect(message).not.toContain(TOKEN);
  expect(message).not.toContain("private-token-response-body");
  expect(calls).toHaveLength(1);
});
