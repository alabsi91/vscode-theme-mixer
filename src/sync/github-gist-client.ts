/** Talks to the GitHub gists API and nothing else. Knows nothing about themes. Never throws. */

const GITHUB_API_BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2026-03-10";

const GISTS_PAGE_SIZE = 100;

/** Only these hosts ever see the token. */
const GITHUB_HOST_NAME_PATTERN = /(?:^|\.)(?:github\.com|githubusercontent\.com)$/;

export interface RateLimit {
  remaining: number;
  /** Milliseconds since the epoch. */
  resetAt: number;
}

export type GistResult<T> =
  { ok: true; value: T; rateLimit?: RateLimit } | { ok: false; status: number; message: string; rateLimit?: RateLimit };

export interface GistFile {
  rawUrl: string;
  size: number;
  /** Over 1MB the API sends `truncated` and the whole text is at `rawUrl`. */
  truncated: boolean;
  content?: string;
}

export interface GistSnapshot {
  etag?: string;
  updatedAt: string;
  files: Record<string, GistFile>;
}

export type GistReadResult = { notModified: true } | { notModified: false; gist: GistSnapshot };

export interface GistUpdateResult {
  etag?: string;
  updatedAt: string;
}

/** Null removes the file. Content is never empty, the API rejects that. */
export type GistFileChanges = Record<string, { content: string } | null>;

interface GistListItem {
  id: string;
  description: string | null;
  created_at: string;
}

interface GistFileResponse {
  raw_url: string;
  size: number;
  truncated?: boolean;
  content?: string;
}

interface GistResponse {
  id: string;
  updated_at: string;
  files: Record<string, GistFileResponse>;
}

/** The oldest gist whose description matches, or undefined. */
export async function findGistByDescription(token: string, description: string): Promise<GistResult<string | undefined>> {
  let oldestMatch: GistListItem | undefined;

  for (let page = 1; ; page++) {
    const result = await requestJson<GistListItem[]>(token, "GET", `/gists?per_page=${GISTS_PAGE_SIZE}&page=${page}`);
    if (!result.ok) {
      return result;
    }

    for (const gist of result.value) {
      if (gist.description !== description) continue;

      if (!oldestMatch || gist.created_at < oldestMatch.created_at) {
        oldestMatch = gist;
      }
    }

    if (result.value.length < GISTS_PAGE_SIZE) {
      return { ok: true, value: oldestMatch?.id, rateLimit: result.rateLimit };
    }
  }
}

/** Secret gist. Returns its id. */
export async function createGist(
  token: string,
  description: string,
  files: Record<string, { content: string }>
): Promise<GistResult<string>> {
  const result = await requestJson<GistResponse>(token, "POST", "/gists", { description, public: false, files });
  if (!result.ok) {
    return result;
  }

  return { ok: true, value: result.value.id, rateLimit: result.rateLimit };
}

/** With an ETag, an unchanged gist answers 304 and costs no rate limit. */
export async function readGist(token: string, gistId: string, etag?: string): Promise<GistResult<GistReadResult>> {
  const headers = etag === undefined ? undefined : { "If-None-Match": etag };

  const response = await sendRequest(
    token,
    "GET",
    `${GITHUB_API_BASE_URL}/gists/${encodeURIComponent(gistId)}`,
    undefined,
    headers
  );
  if (!response.ok) {
    return response;
  }

  const rateLimit = readRateLimit(response.value);

  if (response.value.status === 304) {
    return { ok: true, value: { notModified: true }, rateLimit };
  }

  const parsed = await parseJsonResponse<GistResponse>(response.value);
  if (!parsed.ok) {
    return parsed;
  }

  const files: Record<string, GistFile> = {};

  for (const [fileName, file] of Object.entries(parsed.value.files)) {
    files[fileName] = { rawUrl: file.raw_url, size: file.size, truncated: file.truncated === true, content: file.content };
  }

  const gist: GistSnapshot = { etag: response.value.headers.get("etag") ?? undefined, updatedAt: parsed.value.updated_at, files };

  return { ok: true, value: { notModified: false, gist }, rateLimit };
}

export async function readRawFile(token: string, rawUrl: string): Promise<GistResult<string>> {
  const response = await sendRequest(token, "GET", rawUrl);
  if (!response.ok) {
    return response;
  }

  if (!response.value.ok) {
    return { ok: false, status: response.value.status, message: await readErrorMessage(response.value) };
  }

  try {
    return { ok: true, value: await response.value.text() };
  } catch (error) {
    return { ok: false, status: 0, message: getErrorMessage(error) };
  }
}

/** Partial per file. Files not named are left as they are. */
export async function updateGist(token: string, gistId: string, files: GistFileChanges): Promise<GistResult<GistUpdateResult>> {
  const response = await sendRequest(token, "PATCH", `${GITHUB_API_BASE_URL}/gists/${encodeURIComponent(gistId)}`, { files });
  if (!response.ok) {
    return response;
  }

  const parsed = await parseJsonResponse<GistResponse>(response.value);
  if (!parsed.ok) {
    return parsed;
  }

  const value: GistUpdateResult = { etag: response.value.headers.get("etag") ?? undefined, updatedAt: parsed.value.updated_at };

  return { ok: true, value, rateLimit: readRateLimit(response.value) };
}

export async function deleteGist(token: string, gistId: string): Promise<GistResult<void>> {
  const response = await sendRequest(token, "DELETE", `${GITHUB_API_BASE_URL}/gists/${encodeURIComponent(gistId)}`);
  if (!response.ok) {
    return response;
  }

  const rateLimit = readRateLimit(response.value);

  if (!response.value.ok) {
    return { ok: false, status: response.value.status, message: await readErrorMessage(response.value), rateLimit };
  }

  return { ok: true, value: undefined, rateLimit };
}

// ---------------------------------------------------------------------------------------------
// Plumbing

async function requestJson<T>(token: string, method: string, path: string, body?: unknown): Promise<GistResult<T>> {
  const response = await sendRequest(token, method, `${GITHUB_API_BASE_URL}${path}`, body);
  if (!response.ok) {
    return response;
  }

  return parseJsonResponse<T>(response.value);
}

// A response of any status is ok here. No response at all is status 0.
async function sendRequest(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<GistResult<Response>> {
  if (!isGitHubUrl(url)) {
    return { ok: false, status: 0, message: `Refusing to send the GitHub token to ${url}` };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...extraHeaders,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: true, value: response };
  } catch (error) {
    return { ok: false, status: 0, message: getErrorMessage(error) };
  }
}

async function parseJsonResponse<T>(response: Response): Promise<GistResult<T>> {
  const rateLimit = readRateLimit(response);

  if (!response.ok) {
    return { ok: false, status: response.status, message: await readErrorMessage(response), rateLimit };
  }

  try {
    return { ok: true, value: (await response.json()) as T, rateLimit };
  } catch (error) {
    return { ok: false, status: response.status, message: `Unreadable response: ${getErrorMessage(error)}`, rateLimit };
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallbackMessage = `${response.status} ${response.statusText}`.trim();

  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { message?: unknown };

    return typeof parsed.message === "string" ? parsed.message : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function readRateLimit(response: Response): RateLimit | undefined {
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));

  if (!response.headers.has("x-ratelimit-remaining") || Number.isNaN(remaining) || Number.isNaN(resetSeconds)) {
    return undefined;
  }

  return { remaining, resetAt: resetSeconds * 1000 };
}

function isGitHubUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && GITHUB_HOST_NAME_PATTERN.test(parsedUrl.hostname);
  } catch {
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
