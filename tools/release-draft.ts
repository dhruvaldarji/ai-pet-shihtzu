#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  RELEASE_ASSET_NAMES,
  parseStableVersion,
  validateReleaseDirectory,
  validateReleaseSourceBinding,
} from "./release";

const API_BASE = "https://api.github.com";
const API_REPOSITORY = "dhruvaldarji/ai-pet-shihtzu";
const API_REPO_PATH = `/repos/${API_REPOSITORY}`;
const API_VERSION = "2022-11-28";
const RELEASE_ENVIRONMENT = "release-approval";
const EXPECTED_ASSET_NAMES = new Set<string>(RELEASE_ASSET_NAMES);
const SAFE_REDIRECT_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

type FetchInput = string | URL | Request;
type Fetcher = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type OperationContext = { eventName: string; ref: string; repository: string };
type DraftOptions = {
  version: string;
  source: string;
  directory: string;
  token: string;
  context?: OperationContext;
  fetcher?: Fetcher;
};
type DraftDependencies = {
  fetcher?: Fetcher;
  validateDirectory?: typeof validateReleaseDirectory;
  validateSourceBinding?: typeof validateReleaseSourceBinding;
};
type ApiAsset = { id: number; name: string; size: number; state: "uploaded" };
type ApiRelease = {
  id: number;
  tag_name: string;
  draft: boolean;
  target_commitish: string;
  upload_url: string;
};

class ApiFailure extends Error {
  constructor(readonly status: number) {
    super("GitHub API request failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function apiHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function apiJson(fetcher: Fetcher, token: string, path: string, init: RequestInit = {}) {
  const response = await fetcher(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...apiHeaders(token),
      ...(init.headers as Record<string, string> | undefined),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ApiFailure(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("GitHub API returned an invalid response");
  }
}

function parseRelease(value: unknown): ApiRelease {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.tag_name !== "string" ||
    typeof value.draft !== "boolean" ||
    typeof value.target_commitish !== "string" ||
    typeof value.upload_url !== "string"
  ) {
    throw new Error("GitHub release metadata is invalid");
  }
  return {
    id: value.id,
    tag_name: value.tag_name,
    draft: value.draft,
    target_commitish: value.target_commitish,
    upload_url: value.upload_url,
  };
}

function parseAsset(value: unknown): ApiAsset {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.name !== "string" ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.state !== "uploaded"
  ) {
    throw new Error("GitHub release asset metadata is invalid");
  }
  return { id: value.id, name: value.name, size: value.size, state: "uploaded" };
}

async function getRelease(fetcher: Fetcher, token: string, version: string) {
  try {
    return parseRelease(
      await apiJson(
        fetcher,
        token,
        `${API_REPO_PATH}/releases/tags/${encodeURIComponent(version)}`,
      ),
    );
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null;
    throw error;
  }
}

async function findListedRelease(fetcher: Fetcher, token: string, version: string) {
  const matches: ApiRelease[] = [];
  for (let page = 1; page <= 100; page++) {
    const value = await apiJson(
      fetcher,
      token,
      `${API_REPO_PATH}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(value)) throw new Error("GitHub releases response is invalid");
    for (const item of value) {
      const release = parseRelease(item);
      if (release.tag_name === version) matches.push(release);
    }
    if (value.length < 100) {
      if (matches.length > 1) throw new Error("Multiple GitHub releases match this version");
      return matches[0] ?? null;
    }
  }
  throw new Error("GitHub release pagination exceeded the safety limit");
}

async function getTagCommit(fetcher: Fetcher, token: string, version: string) {
  let reference: unknown;
  try {
    reference = await apiJson(
      fetcher,
      token,
      `${API_REPO_PATH}/git/ref/tags/${encodeURIComponent(version)}`,
    );
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null;
    throw error;
  }
  if (
    !isRecord(reference) ||
    reference.ref !== `refs/tags/${version}` ||
    !isRecord(reference.object) ||
    typeof reference.object.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(reference.object.sha)
  ) {
    throw new Error("Git tag reference metadata is invalid");
  }
  const commit = await apiJson(
    fetcher,
    token,
    `${API_REPO_PATH}/commits/${encodeURIComponent(version)}`,
  );
  if (!isRecord(commit) || typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha))
    throw new Error("Git tag commit metadata is invalid");
  return commit.sha;
}

async function requireProtectedEnvironment(fetcher: Fetcher, token: string) {
  const response = await apiJson(
    fetcher,
    token,
    `${API_REPO_PATH}/environments/${RELEASE_ENVIRONMENT}`,
  );
  if (!isRecord(response) || !Array.isArray(response.protection_rules))
    throw new Error("Release environment protection is not configured");
  const reviewers = response.protection_rules.some(
    (rule) =>
      isRecord(rule) &&
      rule.type === "required_reviewers" &&
      Array.isArray(rule.reviewers) &&
      rule.reviewers.length > 0,
  );
  if (!reviewers) throw new Error("Release environment requires an owner reviewer");
}

async function listAssets(fetcher: Fetcher, token: string, releaseId: number) {
  const assets = new Map<string, ApiAsset>();
  const ids = new Set<number>();
  for (let page = 1; page <= 100; page++) {
    const value = await apiJson(
      fetcher,
      token,
      `${API_REPO_PATH}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    );
    if (!Array.isArray(value)) throw new Error("GitHub release assets response is invalid");
    for (const item of value) {
      const asset = parseAsset(item);
      if (!EXPECTED_ASSET_NAMES.has(asset.name) || assets.has(asset.name) || ids.has(asset.id))
        throw new Error("GitHub release contains an unexpected or duplicate asset");
      assets.set(asset.name, asset);
      ids.add(asset.id);
    }
    if (value.length < 100) return assets;
  }
  throw new Error("GitHub release asset pagination exceeded the safety limit");
}

function validateDownloadRedirect(location: string) {
  const url = new URL(location, API_BASE);
  if (
    url.protocol !== "https:" ||
    !SAFE_REDIRECT_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("GitHub asset redirect target is not trusted");
  }
  return url;
}

async function readAsset(fetcher: Fetcher, token: string, assetId: number) {
  const url = `${API_BASE}${API_REPO_PATH}/releases/assets/${assetId}`;
  const response = await fetcher(url, {
    headers: apiHeaders(token, "application/octet-stream"),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 200) return Buffer.from(await response.arrayBuffer());
  if (![301, 302, 303, 307, 308].includes(response.status)) throw new ApiFailure(response.status);
  const location = response.headers.get("location");
  if (!location) throw new Error("GitHub asset redirect is missing a target");
  const redirect = validateDownloadRedirect(location);
  const downloaded = await fetcher(redirect, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (downloaded.status !== 200) throw new ApiFailure(downloaded.status);
  return Buffer.from(await downloaded.arrayBuffer());
}

async function verifyExistingAssets(
  fetcher: Fetcher,
  token: string,
  assets: ReadonlyMap<string, ApiAsset>,
  files: ReadonlyMap<string, Buffer>,
) {
  for (const [name, asset] of assets) {
    const expected = files.get(name);
    if (!expected || asset.size !== expected.length)
      throw new Error("Existing GitHub release asset differs from the verified artifact");
    const actual = await readAsset(fetcher, token, asset.id);
    if (!actual.equals(expected))
      throw new Error("Existing GitHub release asset differs from the verified artifact");
  }
}

function uploadEndpoint(uploadTemplate: string, releaseId: number) {
  const suffix = "{?name,label}";
  if (!uploadTemplate.endsWith(suffix)) throw new Error("GitHub upload URL template is invalid");
  const url = new URL(uploadTemplate.slice(0, -suffix.length));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `${API_REPO_PATH}/releases/${releaseId}/assets`
  ) {
    throw new Error("GitHub upload URL is not the canonical repository endpoint");
  }
  return url;
}

async function uploadAsset(
  fetcher: Fetcher,
  token: string,
  endpoint: URL,
  name: string,
  bytes: Buffer,
) {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      ...apiHeaders(token),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ApiFailure(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("GitHub upload response is invalid");
  }
  const asset = parseAsset(value);
  if (asset.name !== name || asset.size !== bytes.length)
    throw new Error("GitHub uploaded asset metadata differs from the artifact");
  const readback = await readAsset(fetcher, token, asset.id);
  if (!readback.equals(bytes)) throw new Error("GitHub uploaded asset readback differs");
}

function operationContext(context?: OperationContext): OperationContext {
  return (
    context ?? {
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      ref: process.env.GITHUB_REF ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
    }
  );
}

async function findAndVerifyReleaseAssets(
  fetcher: Fetcher,
  token: string,
  release: ApiRelease,
  files: ReadonlyMap<string, Buffer>,
) {
  const assets = await listAssets(fetcher, token, release.id);
  await verifyExistingAssets(fetcher, token, assets, files);
  return assets;
}

export async function createDraftRelease(
  options: DraftOptions,
  dependencies: DraftDependencies = {},
) {
  parseStableVersion(options.version);
  if (!/^[a-f0-9]{40}$/.test(options.source))
    throw new Error("Source must be a full lowercase SHA");
  const validateSource = dependencies.validateSourceBinding ?? validateReleaseSourceBinding;
  const binding = await validateSource(resolve(import.meta.dir, ".."), options.source);
  const validate = dependencies.validateDirectory ?? validateReleaseDirectory;
  const validated = await validate(options.directory, {
    version: options.version,
    sourceCommit: options.source,
    atlasSha256: binding.atlasSha256,
    softwareLicenseSha256: binding.softwareLicenseSha256,
    artworkLicenseSha256: binding.artworkLicenseSha256,
  });
  const context = operationContext(options.context);
  if (
    context.eventName !== "workflow_dispatch" ||
    context.ref !== "refs/heads/main" ||
    context.repository !== API_REPOSITORY
  ) {
    throw new Error("Draft releases require the canonical manual main-branch workflow");
  }
  if (!options.token) throw new Error("GitHub token is required for the draft operation");
  const fetcher = dependencies.fetcher ?? options.fetcher ?? fetch;
  await requireProtectedEnvironment(fetcher, options.token);

  const existing =
    (await getRelease(fetcher, options.token, options.version)) ??
    (await findListedRelease(fetcher, options.token, options.version));
  const tagCommit = await getTagCommit(fetcher, options.token, options.version);
  if (existing && existing.tag_name !== options.version)
    throw new Error("Existing release tag does not match the requested version");
  if (tagCommit && tagCommit !== options.source)
    throw new Error("Existing Git tag points to another source commit");
  if (existing?.draft) {
    if (existing.target_commitish !== options.source)
      throw new Error("Existing draft targets another source commit");
  } else if (existing && !tagCommit) {
    throw new Error("Existing published release is missing its Git tag");
  }

  if (existing && !existing.draft) {
    const assets = await findAndVerifyReleaseAssets(
      fetcher,
      options.token,
      existing,
      validated.files,
    );
    if (assets.size !== RELEASE_ASSET_NAMES.length)
      throw new Error("Published release is missing immutable assets");
    return { state: "published-unchanged" as const };
  }

  let release = existing;
  let created = false;
  if (!release) {
    const value = await apiJson(fetcher, options.token, `${API_REPO_PATH}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.github+json" },
      body: JSON.stringify({
        tag_name: options.version,
        target_commitish: options.source,
        name: `Louis ${options.version}`,
        body: "Verified source-bound draft. Not published.",
        draft: true,
        prerelease: false,
        make_latest: "false",
      }),
    });
    release = parseRelease(value);
    if (
      !release.draft ||
      release.tag_name !== options.version ||
      release.target_commitish !== options.source
    ) {
      throw new Error("GitHub created a draft with unexpected source metadata");
    }
    const createdTag = await getTagCommit(fetcher, options.token, options.version);
    if (createdTag && createdTag !== options.source)
      throw new Error("Created release tag does not match the approved source commit");
    created = true;
  }

  const endpoint = uploadEndpoint(release.upload_url, release.id);
  let assets = await findAndVerifyReleaseAssets(fetcher, options.token, release, validated.files);
  for (const name of RELEASE_ASSET_NAMES) {
    if (assets.has(name)) continue;
    const bytes = validated.files.get(name);
    if (!bytes) throw new Error("Verified release artifact is incomplete");
    await uploadAsset(fetcher, options.token, endpoint, name, bytes);
    assets = await listAssets(fetcher, options.token, release.id);
    await verifyExistingAssets(fetcher, options.token, assets, validated.files);
  }
  if (assets.size !== RELEASE_ASSET_NAMES.length)
    throw new Error("Draft release did not reach the complete immutable asset set");
  assets = await findAndVerifyReleaseAssets(fetcher, options.token, release, validated.files);
  if (assets.size !== RELEASE_ASSET_NAMES.length)
    throw new Error("Draft release readback is incomplete");
  return { state: created ? ("created" as const) : ("resumed" as const) };
}

function parseArguments(args: string[]) {
  if (args[0] === "--") args.shift();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--version", "--source", "--directory"].includes(name) || !value || values.has(name)) {
      throw new Error("Invalid draft release arguments");
    }
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error("Version, source, and artifact directory are required");
  const version = values.get("--version");
  const source = values.get("--source");
  const directory = values.get("--directory");
  if (!version || !source || !directory)
    throw new Error("Version, source, and artifact directory are required");
  return {
    version,
    source,
    directory,
  };
}

if (import.meta.main) {
  try {
    await createDraftRelease({
      ...parseArguments(process.argv.slice(2)),
      token: process.env.GITHUB_TOKEN ?? "",
    });
    console.log("Protected draft release operation completed; the release remains unpublished.");
  } catch {
    console.error("Draft release operation failed; inspect protected release state privately.");
    process.exitCode = 1;
  }
}
