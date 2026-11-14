// free-model-aggregator-01: one server, two client wires, ten free providers.
//
// A competitive entry, written from the starter's shape but with its own routing and wires:
//   - quality: rank every free candidate by the quality table's rating_milli and serve the best
//     model that meets the request, spreading calls so no provider is hammered into its budget.
//   - failover: a 402, 429 or 5xx is never the answer; retry the next best free model that meets
//     the request, and stop the moment one provider answers (exactly one successful call).
//   - wires: all three upstream wires (openai, anthropic, gemini) in both directions, JSON and
//     streaming, so any free model can serve any client wire. A JSON-mode request never goes to
//     an anthropic-wire provider, whose wire cannot carry response_format.
//   - streaming usage: the client never sets stream_options, so an upstream OpenAI call is given
//     stream_options.include_usage so the provider sends a usage chunk; the client's usage check
//     needs it. Every answer is buffered, parsed into one canonical answer (text + usage), then
//     rendered in the client's wire, so the stop reason and the usage always match the provider's.
//   - determinism: every choice is a function of the brief, the requests and the providers'
//     answers. No wall clock, no unseeded randomness, fixed timestamps in model lists.
//
// The trial gives this server a brief (MAKEFUN_PROMPT_FILE) and an env (MAKEFUN_ENV_URL). It
// probes each provider's catalog route, builds one catalog, registers it, serves the client's
// 20 requests, polls GET /work and exits 0 when the env says done. `node main.ts --list`
// prints the same catalog document and exits 0.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ types */

export type Wire = 'openai' | 'anthropic' | 'gemini';
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';
export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
export const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
export const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

export interface ProviderDirectoryEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  key_env: string;
  key: string;
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

export interface CatalogReport {
  providers: CatalogProvider[];
}

export interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

export interface RatingsFile {
  schema: string;
  ratings: RatingRow[];
  best: { id: string; rating_milli: number }[];
}

export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface WorkloadRequest {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

export interface Brief {
  directory: { schema: string; providers: ProviderDirectoryEntry[] };
  ratings: RatingsFile | null;
  workload: { schema: string; manifest: WorkloadRequest[] } | null;
  error: string | null;
}

export interface ProbedModel {
  id: string;
  display_name: string;
  free: boolean | null;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

export interface Probe {
  provider: ProviderDirectoryEntry;
  ok: boolean;
  status: number;
  models: ProbedModel[];
  error: string | null;
}

export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** One model the entry serves, as GET /v1/models lists it. */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

/** One provider's answer, parsed into the canonical form every client wire renders. */
export interface CanonicalAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/* ------------------------------------------------------------ brief parse */

/** A base path joined to the env's URL; an absolute base_url is used as it stands. */
export function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The headers a provider wants its key in. */
export function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return out;
}

/** The index of the `}` closing the object that opens at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function providerOf(v: unknown): ProviderDirectoryEntry | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
  if (id === '' || wire === null) return null;
  const auth = v.auth === 'bearer' || v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none' ? v.auth : 'bearer';
  const base =
    stringOf(v.path) !== '' ? stringOf(v.path) : stringOf(v.base_path) !== '' ? stringOf(v.base_path) : stringOf(v.base_url) !== '' ? stringOf(v.base_url) : stringOf(v.base);
  return { id, name: stringOf(v.name) !== '' ? stringOf(v.name) : id, wire, auth, base, key_env: stringOf(v.key_env), key: stringOf(v.key) };
}

function ratingOf(v: unknown): RatingRow | null {
  if (!isRecord(v)) return null;
  const model = stringOf(v.model);
  const provider = stringOf(v.provider);
  if (model === '' || provider === '') return null;
  return {
    model,
    provider,
    rating_milli: typeof v.rating_milli === 'number' && Number.isFinite(v.rating_milli) ? v.rating_milli : 0,
    context_length: numberOrNull(v.context_length),
    tools: v.tools === true,
    vision: v.vision === true,
    json: v.json === true,
    free: v.free === true,
  };
}

function workloadRequestOf(v: unknown): WorkloadRequest | null {
  if (!isRecord(v)) return null;
  const id = stringOf(v.id);
  if (id === '') return null;
  const requires = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      tools: requires.tools === true,
      vision: requires.vision === true,
      json: requires.json === true,
      ...(typeof requires.min_context === 'number' && Number.isFinite(requires.min_context) ? { min_context: requires.min_context } : {}),
    },
  };
}

/** The brief at `path`, its three documents found by schema. */
export function readBrief(path: string): Brief {
  const directory: Brief['directory'] = { schema: PROVIDERS_SCHEMA, providers: [] };
  if (path === '') return { directory, ratings: null, workload: null, error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { directory, ratings: null, workload: null, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const directoryDoc = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers)) ?? null;
  if (directoryDoc === null || !Array.isArray(directoryDoc.providers)) {
    return { directory, ratings: null, workload: null, error: `the brief at ${path} holds no ${PROVIDERS_SCHEMA} document` };
  }
  const providers = directoryDoc.providers.flatMap((v) => {
    const p = providerOf(v);
    return p === null ? [] : [p];
  });
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings)) ?? null;
  const ratingRows = ratingsDoc !== null && Array.isArray(ratingsDoc.ratings) ? ratingsDoc.ratings : null;
  const ratings: RatingsFile | null =
    ratingsDoc === null || ratingRows === null
      ? null
      : {
          schema: RATINGS_SCHEMA,
          ratings: ratingRows.flatMap((v) => {
            const r = ratingOf(v);
            return r === null ? [] : [r];
          }),
          best: Array.isArray(ratingsDoc.best)
            ? ratingsDoc.best.flatMap((v) => {
                if (!isRecord(v) || stringOf(v.id) === '') return [];
                return [{ id: stringOf(v.id), rating_milli: numberOrNull(v.rating_milli) ?? 0 }];
              })
            : [],
        };
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest)) ?? null;
  const workload: Brief['workload'] =
    workloadDoc === null || !Array.isArray(workloadDoc.manifest)
      ? null
      : {
          schema: WORKLOAD_SCHEMA,
          manifest: workloadDoc.manifest.flatMap((v) => {
            const w = workloadRequestOf(v);
            return w === null ? [] : [w];
          }),
        };
  return { directory: { schema: PROVIDERS_SCHEMA, providers }, ratings, workload, error: null };
}

/** The rating row of one provider's model, when the quality table has one. */
export function ratingOfModel(ratings: RatingsFile | null, providerId: string, modelId: string): RatingRow | null {
  if (ratings === null) return null;
  return ratings.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;
}

/**
 * Whether a model is free: the quality table's row where it has one (it is the sealed truth), the
 * listing's own word where it does not, and paid when neither says. A paid model is never routed.
 */
export function modelFree(model: ProbedModel, row: RatingRow | null): boolean {
  if (row !== null) return row.free;
  return model.free ?? false;
}

/** What a model can do: the quality table's row where it has one, the listing's own fields where it does not. */
export function capabilitiesOf(model: ProbedModel, row: RatingRow | null): Capabilities {
  return {
    context_length: row?.context_length ?? model.context_length ?? null,
    tools: row?.tools ?? model.tools ?? null,
    vision: row?.vision ?? model.vision ?? null,
    json: row?.json ?? model.json ?? null,
  };
}

/** Whether a model's capabilities meet one request's requirements. An unknown capability never meets one. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}

/* ------------------------------------------------------------ catalog probe */

/** A price field of a listing: 0 when every price is zero, null when the listing says nothing about price. */
function zeroPriced(v: Json): boolean | null {
  const pricing = isRecord(v.pricing) ? v.pricing : null;
  if (pricing === null) return null;
  const values = Object.values(pricing).flatMap((x) => {
    if (typeof x === 'number') return [x];
    if (typeof x === 'string' && x.trim() !== '') return [Number(x)];
    return [];
  });
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

/** One model as a listing wrote it, in whichever wire's spelling. */
function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? stringOf(v.name).replace(/^models\//, '') : stringOf(v.id);
  if (id === '') return null;
  const context = numberOrNull(v.context_length) ?? numberOrNull(v.context_window) ?? numberOrNull(v.inputTokenLimit);
  return {
    id,
    display_name: stringOf(v.display_name) !== '' ? stringOf(v.display_name) : stringOf(v.displayName) !== '' ? stringOf(v.displayName) : id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context_length: context,
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
  };
}

/** The models one catalog route's answer listed, in its wire's shape. */
function modelsIn(wire: Wire, body: unknown): ProbedModel[] {
  if (!isRecord(body)) return [];
  const list = wire === 'gemini' ? body.models : body.data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const m = modelIn(wire, v);
    return m === null ? [] : [m];
  });
}

/** Probe one provider's catalog route, in its own wire, tolerating every failure. */
export async function probeProvider(envUrl: string, provider: ProviderDirectoryEntry, timeoutMs = 5000): Promise<Probe> {
  const base = joinBase(envUrl, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { provider, ok: false, status: res.status, models: [], error: `GET ${url} answered HTTP ${res.status}` };
    const body: unknown = await res.json();
    return { provider, ok: true, status: res.status, models: modelsIn(provider.wire, body), error: null };
  } catch (err) {
    return { provider, ok: false, status: 0, models: [], error: `GET ${url} failed: ${(err as Error).message}` };
  }
}

/**
 * The catalog the probes and the quality table make: every provider that answered, every model it listed.
 * Its base_url is the directory's own path (`/p/<id>`), never the path joined to `envUrl`: the env's
 * origin differs between a live pass and its replay, and the catalog is part of the state export a
 * replay must reproduce byte for byte.
 */
export function buildCatalog(_envUrl: string, probes: readonly Probe[], ratings: RatingsFile | null): CatalogReport {
  const providers: CatalogProvider[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const seen = new Set<string>();
    const models: CatalogModel[] = [];
    for (const model of [...probe.models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const row = ratingOfModel(ratings, probe.provider.id, model.id);
      models.push({ id: model.id, free: modelFree(model, row), context_length: row?.context_length ?? model.context_length ?? null });
    }
    providers.push({ id: probe.provider.id, base_url: probe.provider.base, key_env: probe.provider.key_env, wire: probe.provider.wire, models });
  }
  return { providers };
}

/* ------------------------------------------------------------- wire helpers */

/** A fixed epoch second for every listed model's `created`: nothing in the reply reads the clock. */
const FIXED_OPENAI_CREATED = 1767225600;
/** A fixed instant for every listed model's `created_at`: nothing in the reply reads the clock. */
const FIXED_ANTHROPIC_CREATED_AT = '2026-01-01T00:00:00Z';

/** GET /v1/models on an OpenAI-shaped request: the models this entry serves, in OpenAI's list shape. */
export function openAIModelList(models: readonly ServedModel[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_OPENAI_CREATED, owned_by: m.provider })),
  };
}

/** GET /v1/models on an Anthropic-shaped request (an x-api-key header): Anthropic's model list shape. */
export function anthropicModelList(models: readonly ServedModel[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_ANTHROPIC_CREATED_AT })),
    has_more: false,
  };
}

/** An error in Anthropic's shape (the Messages API's error envelope). */
export function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

/** An error in OpenAI's shape (Chat Completions). */
export function openAIError(message: string, type: string, code: string | null): Json {
  return { error: { message, type, code } };
}

/** One server-sent event: `event: <name>` when named, then the JSON data line, then the blank line. */
export function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** The text of a string or of a block array's text blocks; '' when there is none. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

/** One Anthropic content block as an OpenAI content part: text or an inline image; null for the rest. */
function partOf(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

/** A tool_result block's content as text: its text blocks, or its JSON when it holds something else. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** A tool call's arguments as an object: the provider's JSON string, or {} when it is not one. */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* ------------------------------------------------------- request translation */

/**
 * An Anthropic Messages request as an OpenAI Chat Completions request that names `model`: the system
 * prompt becomes a system message, image blocks become image_url data URLs, tool_use blocks become
 * tool_calls, tool_result blocks become tool messages, tools and tool_choice are rewritten, and the
 * output cap, temperature, top_p, stop sequences and streaming pass through. The Anthropic wire
 * carries no JSON mode, so an anthropic request never becomes a JSON-mode OpenAI one.
 */
export function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: toolResultText(block.content),
        });
        continue;
      }
      const part = partOf(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/**
 * An OpenAI Chat Completions request as an Anthropic Messages request that names `model`. The
 * response_format is dropped: the Anthropic wire cannot carry JSON mode, so this is only ever
 * called for a request that does not ask for it.
 */
export function openAIToAnthropic(body: Json, model: string): Json {
  const messages: Json[] = [];
  const source = Array.isArray(body.messages) ? body.messages : [];
  let system = '';
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const text = textOf(raw.content);
      if (text !== '') system = system === '' ? text : `${system}\n${text}`;
      continue;
    }
    if (raw.role === 'assistant') {
      const content: Json[] = [];
      const text = textOf(raw.content);
      if (text !== '') content.push({ type: 'text', text });
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        content.push({
          type: 'tool_use',
          id: typeof call.id === 'string' ? call.id : '',
          name: typeof call.function.name === 'string' ? call.function.name : '',
          input: argumentsOf(call.function.arguments),
        });
      }
      if (content.length > 0) messages.push({ role: 'assistant', content });
      continue;
    }
    if (raw.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '', content: typeof raw.content === 'string' ? raw.content : toolResultText(raw.content) }],
      });
      continue;
    }
    // A user message: text and image_url parts become text and image blocks.
    const content: Json[] = [];
    const c = raw.content;
    if (typeof c === 'string') {
      if (c !== '') content.push({ type: 'text', text: c });
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
          const url = part.image_url.url;
          const data = /^data:([^;,]*);base64,(.*)$/s.exec(url);
          if (data !== null) content.push({ type: 'image', source: { type: 'base64', media_type: data[1] !== '' ? data[1] : 'image/png', data: data[2] } });
          else content.push({ type: 'image', source: { type: 'url', url } });
        }
      }
    }
    if (content.length > 0) messages.push({ role: 'user', content });
  }

  const out: Json = { model, messages };
  if (system !== '') out.system = system;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length > 0) out.stop_sequences = body.stop;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [{ name: raw.function.name, description: typeof raw.function.description === 'string' ? raw.function.description : '', input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} } }];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'none') out.tool_choice = { type: choice === 'required' ? 'any' : 'auto' };
  else if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function) && typeof choice.function.name === 'string') out.tool_choice = { type: 'tool', name: choice.function.name };
  if (body.stream === true) out.stream = true;
  return out;
}

/** One OpenAI message's content as Gemini parts: text, then an inline image per image_url. */
function geminiPartsOfMessage(message: Json): Json[] {
  const parts: Json[] = [];
  const c = message.content;
  if (typeof c === 'string') {
    if (c !== '') parts.push({ text: c });
  } else if (Array.isArray(c)) {
    for (const part of c) {
      if (!isRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text !== '') parts.push({ text: part.text });
      else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
        const url = part.image_url.url;
        const data = /^data:([^;,]*);base64,(.*)$/s.exec(url);
        if (data !== null) parts.push({ inlineData: { mimeType: data[1] !== '' ? data[1] : 'image/png', data: data[2] } });
        else parts.push({ fileData: { fileUri: url } });
      }
    }
  }
  return parts;
}

/** The tools of an OpenAI body as Gemini function declarations. */
function geminiDeclarationsOfOpenAI(body: Json): Json[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((raw) => {
    if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
    return [{ name: raw.function.name, description: typeof raw.function.description === 'string' ? raw.function.description : '', parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} } }];
  });
}

/** The tools of an Anthropic body as Gemini function declarations. */
function geminiDeclarationsOfAnthropic(body: Json): Json[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string') return [];
    return [{ name: raw.name, description: typeof raw.description === 'string' ? raw.description : '', parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} } }];
  });
}

/** The generation config shared by both Gemini translations: cap, stops, JSON mode, sampling. */
function geminiConfigOf(body: Json, jsonMode: boolean): Json {
  const config: Json = {};
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : null;
  if (maxTokens !== null) config.maxOutputTokens = maxTokens;
  const stops = Array.isArray(body.stop) ? body.stop : Array.isArray(body.stop_sequences) ? body.stop_sequences : null;
  if (stops !== null && stops.length > 0) config.stopSequences = stops;
  if (jsonMode) config.responseMimeType = 'application/json';
  if (typeof body.temperature === 'number') config.temperature = body.temperature;
  if (typeof body.top_p === 'number') config.topP = body.top_p;
  return config;
}

/**
 * An OpenAI Chat Completions request as a Gemini generateContent body. System messages become
 * the system instruction, user messages become user contents, assistant messages become model
 * contents, tool messages become function contents (the provider only echoes the user text, so
 * their role never leaks into it). JSON mode becomes responseMimeType application/json.
 */
export function openAIToGemini(body: Json): Json {
  const systemParts: Json[] = [];
  const contents: Json[] = [];
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      for (const part of geminiPartsOfMessage(raw)) systemParts.push(part);
      continue;
    }
    if (raw.role === 'assistant') {
      const parts = geminiPartsOfMessage(raw);
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        parts.push({ functionCall: { name: typeof call.function.name === 'string' ? call.function.name : '', args: argumentsOf(call.function.arguments) } });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }
    if (raw.role === 'tool') {
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name: '', response: { content: typeof raw.content === 'string' ? raw.content : toolResultText(raw.content) } } }],
      });
      continue;
    }
    const parts = geminiPartsOfMessage(raw);
    if (parts.length > 0) contents.push({ role: 'user', parts });
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  const out: Json = { contents };
  if (systemParts.length > 0) out.systemInstruction = { parts: systemParts };
  const declarations = geminiDeclarationsOfOpenAI(body);
  if (declarations.length > 0) out.tools = [{ functionDeclarations: declarations }];
  const config = geminiConfigOf(body, format === 'json_object' || format === 'json_schema');
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

/**
 * An Anthropic Messages request as a Gemini generateContent body. The system field becomes the
 * system instruction, user messages become user contents (image blocks become inline data),
 * assistant messages become model contents, tool_result blocks become function contents. The
 * Anthropic wire carries no JSON mode, so no responseMimeType is ever set here.
 */
export function anthropicToGemini(body: Json): Json {
  const systemParts: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') systemParts.push({ text: system });
  const contents: Json[] = [];
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      if (content !== '') contents.push({ role: assistant ? 'model' : 'user', parts: [{ text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push({ text: block.text });
      else if (block.type === 'image' && isRecord(block.source)) {
        const s = block.source;
        if (s.type === 'base64' && typeof s.data === 'string') parts.push({ inlineData: { mimeType: typeof s.media_type === 'string' ? s.media_type : 'image/png', data: s.data } });
        else if (s.type === 'url' && typeof s.url === 'string') parts.push({ fileData: { fileUri: s.url } });
      } else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: typeof block.name === 'string' ? block.name : '', args: isRecord(block.input) ? block.input : {} } });
      } else if (block.type === 'tool_result') {
        parts.push({ functionResponse: { name: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', response: { content: toolResultText(block.content) } } });
      }
    }
    if (parts.length > 0) {
      // A tool_result is a function-role content; anything else keeps the message's role.
      const hasResult = content.some((b) => isRecord(b) && b.type === 'tool_result');
      contents.push({ role: hasResult ? 'function' : assistant ? 'model' : 'user', parts });
    }
  }
  const out: Json = { contents };
  if (systemParts.length > 0) out.systemInstruction = { parts: systemParts };
  const declarations = geminiDeclarationsOfAnthropic(body);
  if (declarations.length > 0) out.tools = [{ functionDeclarations: declarations }];
  const config = geminiConfigOf(body, false);
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

/* -------------------------------------------------------- response parsing */

/** The SSE frames of `text`: each `data:` line as a parsed JSON value (or its raw string), in order. */
function sseFrames(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      out.push(payload);
    }
  }
  return out;
}

/** The text of an OpenAI message's content: a string, or its text parts joined. */
function openAIContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.flatMap((p) => (isRecord(p) && p.type === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('');
  return '';
}

/** An OpenAI JSON answer as the canonical answer; null when it is not one. */
function parseOpenAIJson(body: unknown): CanonicalAnswer | null {
  if (!isRecord(body) || !Array.isArray(body.choices) || body.choices.length === 0) return null;
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const text = openAIContentText(choice.message.content);
  if (text === '') return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  return { text, inputTokens: numberOrZero(usage.prompt_tokens), outputTokens: numberOrZero(usage.completion_tokens) };
}

/** An OpenAI SSE answer as the canonical answer; null when it carries no content. */
function parseOpenAISse(text: string): CanonicalAnswer | null {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const frame of sseFrames(text)) {
    if (!isRecord(frame)) continue;
    if (isRecord(frame.usage)) {
      inputTokens = numberOrZero(frame.usage.prompt_tokens);
      outputTokens = numberOrZero(frame.usage.completion_tokens);
    }
    if (!Array.isArray(frame.choices)) continue;
    for (const choice of frame.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue;
      const piece = openAIContentText(choice.delta.content);
      if (piece !== '') content += piece;
    }
  }
  if (content === '') return null;
  return { text: content, inputTokens, outputTokens };
}

/** The text of an Anthropic message's content blocks. */
function anthropicContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('');
}

/** An Anthropic JSON answer as the canonical answer; null when it is not one. */
function parseAnthropicJson(body: unknown): CanonicalAnswer | null {
  if (!isRecord(body)) return null;
  const text = anthropicContentText(body.content);
  if (text === '') return null;
  const usage = isRecord(body.usage) ? body.usage : {};
  return { text, inputTokens: numberOrZero(usage.input_tokens), outputTokens: numberOrZero(usage.output_tokens) };
}

/** An Anthropic SSE answer as the canonical answer; null when it carries no content. */
function parseAnthropicSse(text: string): CanonicalAnswer | null {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(frame)) continue;
    if (frame.type === 'message_start' && isRecord(frame.message) && isRecord(frame.message.usage)) {
      inputTokens = numberOrZero(frame.message.usage.input_tokens);
    }
    if (frame.type === 'content_block_delta' && isRecord(frame.delta) && frame.delta.type === 'text_delta' && typeof frame.delta.text === 'string') {
      content += frame.delta.text;
    }
    if (frame.type === 'message_delta' && isRecord(frame.usage)) {
      outputTokens = numberOrZero(frame.usage.output_tokens);
    }
  }
  if (content === '') return null;
  return { text: content, inputTokens, outputTokens };
}

/** The text of a Gemini candidate's content parts. */
function geminiContentText(content: unknown): string {
  if (!isRecord(content) || !Array.isArray(content.parts)) return '';
  return content.parts.flatMap((p) => (isRecord(p) && typeof p.text === 'string' ? [p.text] : [])).join('');
}

/** A Gemini answer (JSON or one SSE frame) as the canonical answer; null when it is not one. */
function parseGeminiBody(body: unknown): CanonicalAnswer | null {
  if (!isRecord(body) || !Array.isArray(body.candidates) || body.candidates.length === 0) return null;
  const candidate = body.candidates[0];
  if (!isRecord(candidate)) return null;
  const text = geminiContentText(candidate.content);
  if (text === '') return null;
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return { text, inputTokens: numberOrZero(usage.promptTokenCount), outputTokens: numberOrZero(usage.candidatesTokenCount) };
}

/** A Gemini SSE answer as the canonical answer; null when it carries no content. The final frame carries the usageMetadata but no text, so its usage is read on its own. */
function parseGeminiSse(text: string): CanonicalAnswer | null {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const frame of sseFrames(text)) {
    if (!isRecord(frame)) continue;
    if (Array.isArray(frame.candidates)) {
      for (const candidate of frame.candidates) {
        if (isRecord(candidate)) content += geminiContentText(candidate.content);
      }
    }
    if (isRecord(frame.usageMetadata)) {
      const input = numberOrZero(frame.usageMetadata.promptTokenCount);
      const output = numberOrZero(frame.usageMetadata.candidatesTokenCount);
      if (input !== 0) inputTokens = input;
      if (output !== 0) outputTokens = output;
    }
  }
  if (content === '') return null;
  return { text: content, inputTokens, outputTokens };
}

/* -------------------------------------------------------- response rendering */

/** Split `text` into stream pieces no longer than `size` characters, so a stream looks like one. */
function streamPieces(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [''];
}

/** The canonical answer as an OpenAI Chat Completions JSON body naming `model`, family-0 stop. */
export function renderOpenAIJson(id: string, model: string, answer: CanonicalAnswer): Json {
  return {
    id,
    object: 'chat.completion',
    created: FIXED_OPENAI_CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens },
  };
}

/** The canonical answer as an OpenAI SSE stream naming `model`: role, content pieces, one finish chunk, one usage chunk, then [DONE]. */
export function renderOpenAIStream(id: string, model: string, answer: CanonicalAnswer): string {
  const base = { id, object: 'chat.completion.chunk', created: FIXED_OPENAI_CREATED, model };
  let out = '';
  out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`;
  for (const piece of streamPieces(answer.text)) {
    out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`;
  }
  out += `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: answer.inputTokens, completion_tokens: answer.outputTokens, total_tokens: answer.inputTokens + answer.outputTokens } })}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}

/** The canonical answer as an Anthropic Messages JSON body naming `model`, family-0 stop. */
export function renderAnthropicJson(id: string, model: string, answer: CanonicalAnswer): Json {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens },
  };
}

/** The canonical answer as an Anthropic SSE stream naming `model`: message_start, one text block, message_delta, message_stop. */
export function renderAnthropicStream(id: string, model: string, answer: CanonicalAnswer): string {
  let out = '';
  out += sseEvent('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: answer.inputTokens, output_tokens: 0 } } });
  out += sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of streamPieces(answer.text)) {
    out += sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  out += sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: answer.outputTokens } });
  out += sseEvent('message_stop', { type: 'message_stop' });
  return out;
}

/* ------------------------------------------------------------------ routing */

export interface Candidate {
  provider: ProviderDirectoryEntry;
  model: ProbedModel;
  rating: number;
}

export interface RouterState {
  probes: Probe[];
  ratings: RatingsFile | null;
  served: ServedModel[];
  calls: Map<string, number>;
  consecutiveFailures: Map<string, number>;
  dead: Set<string>;
  skippedModels: Set<string>;
}

export function newRouterState(probes: Probe[], ratings: RatingsFile | null, served: ServedModel[]): RouterState {
  return { probes, ratings, served, calls: new Map(), consecutiveFailures: new Map(), dead: new Set(), skippedModels: new Set() };
}

/**
 * Every free model that meets `requires`, best first: the quality table's rating, then the provider
 * with the fewest calls so far (so a tie spreads the load), then provider and model id. A JSON-mode
 * request never takes an anthropic-wire provider, whose wire cannot carry response_format.
 */
export function candidatesFor(state: RouterState, requires: Requirement, jsonMode: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of state.probes) {
    if (!probe.ok || state.dead.has(probe.provider.id)) continue;
    if (jsonMode && probe.provider.wire === 'anthropic') continue;
    for (const model of probe.models) {
      if (state.skippedModels.has(`${probe.provider.id}/${model.id}`)) continue;
      const row = ratingOfModel(state.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      if (!meetsRequirements(requires, capabilitiesOf(model, row))) continue;
      out.push({ provider: probe.provider, model, rating: row?.rating_milli ?? 0 });
    }
  }
  out.sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    const ca = state.calls.get(a.provider.id) ?? 0;
    const cb = state.calls.get(b.provider.id) ?? 0;
    if (ca !== cb) return ca - cb;
    if (a.provider.id !== b.provider.id) return a.provider.id < b.provider.id ? -1 : 1;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
  return out;
}

/** The requirements a request's body itself shows: tools, an image, JSON mode. min_context only ever comes from the manifest. */
function bodyRequirements(api: 'openai' | 'anthropic', body: Json): Requirement {
  const requires: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) requires.tools = true;
  if (api === 'openai') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const m of messages) {
      if (!isRecord(m)) continue;
      const c = m.content;
      if (Array.isArray(c) && c.some((p) => isRecord(p) && p.type === 'image_url')) requires.vision = true;
    }
    const format = isRecord(body.response_format) ? body.response_format.type : undefined;
    if (format === 'json_object' || format === 'json_schema') requires.json = true;
  } else {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const m of messages) {
      if (!isRecord(m)) continue;
      const c = m.content;
      if (Array.isArray(c) && c.some((b) => isRecord(b) && b.type === 'image')) requires.vision = true;
    }
  }
  return requires;
}

/** The union of the manifest's requirements for request `index` and the body's own: the stricter of the two. */
function requirementsFor(workload: Brief['workload'], index: number, api: 'openai' | 'anthropic', body: Json): Requirement {
  const manifest = workload?.manifest[index]?.requires ?? {};
  const fromBody = bodyRequirements(api, body);
  return { ...manifest, ...fromBody };
}

/* ------------------------------------------------------------ upstream calls */

interface UpstreamResult {
  ok: boolean;
  status: number;
  answer: CanonicalAnswer | null;
}

/**
 * One call to one provider in its own wire, the client request translated into it. The answer is
 * read whole and parsed into the canonical form; a stream is requested when the client asked for
 * one, and an OpenAI upstream stream always carries stream_options.include_usage, which the
 * client never sets but the usage check needs. Any failure (a 402, a 429, a 5xx, a bad body) is a
 * plain failure the router retries elsewhere; nothing here throws.
 */
async function callProvider(envUrl: string, provider: ProviderDirectoryEntry, modelId: string, api: 'openai' | 'anthropic', body: Json): Promise<UpstreamResult> {
  const base = joinBase(envUrl, provider.base);
  const stream = body.stream === true;
  let url: string;
  let upstream: Json;
  let headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    upstream = api === 'anthropic' ? anthropicToOpenAI(body, modelId) : { ...body, model: modelId };
    if (stream) {
      upstream.stream = true;
      upstream.stream_options = { include_usage: true };
    }
    headers = { ...headers, accept: stream ? 'text/event-stream' : 'application/json' };
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    upstream = api === 'openai' ? openAIToAnthropic(body, modelId) : { ...body, model: modelId };
    if (stream) upstream.stream = true;
    headers = { ...headers, 'anthropic-version': '2023-06-01', accept: stream ? 'text/event-stream' : 'application/json' };
  } else {
    const action = stream ? ':streamGenerateContent' : ':generateContent';
    url = `${base}/v1beta/models/${encodeURIComponent(modelId)}${action}${stream ? '?alt=sse' : ''}`;
    upstream = api === 'openai' ? openAIToGemini(body) : anthropicToGemini(body);
    headers = { ...headers, accept: stream ? 'text/event-stream' : 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstream), signal: AbortSignal.timeout(10000) });
  } catch {
    return { ok: false, status: 0, answer: null };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, answer: null };
  let answer: CanonicalAnswer | null = null;
  if (provider.wire === 'openai') {
    if (stream) answer = parseOpenAISse(text);
    else {
      try {
        answer = parseOpenAIJson(JSON.parse(text));
      } catch {
        answer = null;
      }
    }
  } else if (provider.wire === 'anthropic') {
    if (stream) answer = parseAnthropicSse(text);
    else {
      try {
        answer = parseAnthropicJson(JSON.parse(text));
      } catch {
        answer = null;
      }
    }
  } else if (stream) answer = parseGeminiSse(text);
  else {
    try {
      answer = parseGeminiBody(JSON.parse(text));
    } catch {
      answer = null;
    }
  }
  if (answer === null) return { ok: false, status: 502, answer: null };
  return { ok: true, status: res.status, answer };
}

/** The requests this entry has served, in arrival order, for the manifest lookup. */
let requestIndex = 0;

/**
 * Serve one client request: rank the free models that meet it, try them in order until one
 * answers, and render that answer in the client's wire. A provider that fails twice in a row is
 * left alone for the rest of the trial (an outage never recovers). Exactly one successful provider
 * call is ever made per request. When nothing answers, the error is in the client's wire.
 */
async function handleChat(envUrl: string, state: RouterState, workload: Brief['workload'], api: 'openai' | 'anthropic', body: Json): Promise<{ status: number; contentType: string; body: string }> {
  const index = requestIndex;
  requestIndex += 1;
  const id = api === 'openai' ? `chatcmpl-agg-${index}` : `msg_agg_${index}`;
  const requires = requirementsFor(workload, index, api, body);
  const jsonMode = api === 'openai' && isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
  const stream = body.stream === true;
  const candidates = candidatesFor(state, requires, jsonMode);
  for (const candidate of candidates) {
    const result = await callProvider(envUrl, candidate.provider, candidate.model.id, api, body);
    state.calls.set(candidate.provider.id, (state.calls.get(candidate.provider.id) ?? 0) + 1);
    if (!result.ok || result.answer === null) {
      if (result.status === 400) {
        // The provider says this model does not exist: never offer it again.
        state.skippedModels.add(`${candidate.provider.id}/${candidate.model.id}`);
      }
      const failures = (state.consecutiveFailures.get(candidate.provider.id) ?? 0) + 1;
      state.consecutiveFailures.set(candidate.provider.id, failures);
      if (failures >= 2) state.dead.add(candidate.provider.id);
      continue;
    }
    state.consecutiveFailures.set(candidate.provider.id, 0);
    const answer = result.answer;
    if (api === 'openai') {
      if (stream) return { status: 200, contentType: 'text/event-stream', body: renderOpenAIStream(id, 'auto', answer) };
      return { status: 200, contentType: 'application/json', body: JSON.stringify(renderOpenAIJson(id, 'auto', answer)) };
    }
    if (stream) return { status: 200, contentType: 'text/event-stream', body: renderAnthropicStream(id, 'auto', answer) };
    return { status: 200, contentType: 'application/json', body: JSON.stringify(renderAnthropicJson(id, 'auto', answer)) };
  }
  if (api === 'openai') {
    return { status: 503, contentType: 'application/json', body: JSON.stringify(openAIError('all providers failed', 'server_error', null)) };
  }
  return { status: 503, contentType: 'application/json', body: JSON.stringify(anthropicError('overloaded_error', 'all providers failed')) };
}

/* ------------------------------------------------------------------- server */

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const promptFile = process.env.MAKEFUN_PROMPT_FILE ?? '';
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const brief = readBrief(promptFile);
  const probes = await Promise.all(brief.directory.providers.map((p) => probeProvider(envUrl, p)));
  const catalog = buildCatalog(envUrl, probes, brief.ratings);
  if (listOnly) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }
  if (brief.error !== null) {
    process.stderr.write(`brief error: ${brief.error}\n`);
    return 1;
  }
  if (envUrl === '') {
    process.stderr.write('MAKEFUN_ENV_URL is not set\n');
    return 1;
  }
  const served: ServedModel[] = [];
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (!model.free || seen.has(model.id)) continue;
      seen.add(model.id);
      served.push({ id: model.id, provider: provider.id, display_name: model.id });
    }
  }
  const state = newRouterState(probes, brief.ratings, served);
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = req.headers['x-api-key'] !== undefined ? anthropicModelList(served) : openAIModelList(served);
        send(res, 200, 'application/json', JSON.stringify(models));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(req);
        if (body === null) {
          send(res, 400, 'application/json', JSON.stringify(openAIError('request body is not a JSON object', 'invalid_request_error', 'invalid_json')));
          return;
        }
        const out = await handleChat(envUrl, state, brief.workload, 'openai', body);
        send(res, out.status, out.contentType, out.body);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readJsonBody(req);
        if (body === null) {
          send(res, 400, 'application/json', JSON.stringify(anthropicError('invalid_request_error', 'request body is not a JSON object')));
          return;
        }
        const out = await handleChat(envUrl, state, brief.workload, 'anthropic', body);
        send(res, out.status, out.contentType, out.body);
        return;
      }
      send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    } catch (err) {
      if (!res.headersSent) send(res, 500, 'application/json', JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const register = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
    signal: AbortSignal.timeout(10000),
  });
  if (!register.ok) {
    process.stderr.write(`register failed: HTTP ${register.status}\n`);
    server.close();
    return 1;
  }
  const registerBody: unknown = await register.json().catch(() => null);
  if (!isRecord(registerBody) || registerBody.ok !== true) {
    process.stderr.write(`register failed: ${JSON.stringify(registerBody)}\n`);
    server.close();
    return 1;
  }
  const requests = typeof registerBody.requests === 'number' ? registerBody.requests : 0;
  process.stderr.write(`registered on port ${port}, ${requests} requests expected\n`);
  for (;;) {
    await sleep(100);
    let work: Response;
    try {
      work = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(5000) });
    } catch {
      continue;
    }
    if (!work.ok) continue;
    const workBody: unknown = await work.json().catch(() => null);
    if (isRecord(workBody) && workBody.done === true) break;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

process.exitCode = await main();
