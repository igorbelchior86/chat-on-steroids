import path from 'node:path';
import os from 'node:os';
import { TextDecoder } from 'node:util';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import type { Dirent, Stats } from 'node:fs';
import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import type { Root } from '../shared/types.js';
import type {
  SkillDependency,
  SkillLibrary,
  SkillRootSummary,
  SkillSummary,
} from '../shared/skills.js';

export const SKILLS_DIRECTORY_NAME = 'skills';
export const SKILL_FILE_NAME = 'SKILL.md';
export const MAX_SKILL_BYTES = 256 * 1024;
/** Managed-library cap retained for compatibility. */
export const MAX_SKILLS = 128;
export const MAX_SKILL_DIRECTORY_ENTRIES = 512;
export const MAX_SKILL_ERRORS = 128;
export const MAX_SKILL_ID_LENGTH = 64;
export const MAX_SKILL_NAME_CHARS = 160;
export const MAX_SKILL_DESCRIPTION_CHARS = 1000;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const RESERVED_SKILL_IDS = ['prompt'] as const;

export const MAX_EXTERNAL_SKILL_NAME_CHARS = 64;
export const MAX_EXTERNAL_SKILL_DESCRIPTION_CHARS = 1024;
export const MAX_SKILL_SCAN_DEPTH = 6;
export const MAX_SKILL_SCAN_DIRECTORIES = 2000;
export const MAX_SKILL_SCAN_ENTRIES = 20_000;
export const MAX_DISCOVERED_SKILLS = 4096;
export const MAX_SKILL_PACKAGE_ENTRIES = 4096;
export const MAX_SKILL_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SKILLS_CONFIG_BYTES = 256 * 1024;

const WINDOWS_RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const RESERVED_SKILL_ID_SET = new Set<string>(RESERVED_SKILL_IDS);
const BINARY_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const READ_ONLY_ROOT_NAMES = new Set(['skill-user', 'skill-codex', 'skill-system', 'skill-admin']);

export interface SkillScopeOptions {
  projectPath?: string | null;
}

interface LibraryState {
  directory: string;
  directoryReal: string;
  userDataReal: string;
}

interface Frontmatter {
  exists: boolean;
  body: string;
  name?: string;
  description?: string;
  shortDescription?: string;
}

interface ParsedSkill {
  name: string;
  description: string;
  nameSource: 'frontmatter' | 'title' | 'fallback';
  frontmatter: Frontmatter;
}

interface ManagedSkill {
  directory: string;
  directoryReal: string;
  directoryStat: Stats;
  file: string;
  fileStat: Stats;
}

interface DiscoveryRoot extends SkillRootSummary {
  order: number;
}

interface OpenAiMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  allowImplicitInvocation?: boolean;
  dependencies?: SkillDependency[];
}

interface SkillRecord {
  summary: SkillSummary;
  file: string;
  directory: string;
  managedId?: string;
}

interface DiscoveryResult {
  records: SkillRecord[];
  roots: DiscoveryRoot[];
  errors: string[];
  config: EffectiveSkillConfig;
}

interface SkillConfigRule {
  selector: 'name' | 'path';
  value: string;
  enabled: boolean;
}

interface ParsedSkillConfigLayer {
  includeInstructions?: boolean;
  maxContextTokens?: number;
  bundledEnabled?: boolean;
  rules: SkillConfigRule[];
}

interface EffectiveSkillConfig {
  includeInstructions: boolean;
  maxContextTokens?: number;
  bundledEnabled: boolean;
  rules: SkillConfigRule[];
}

let library: LibraryState | null = null;
let mutations: Promise<unknown> = Promise.resolve();

const rawSyncFs: typeof nodeFs = (() => {
  if (!process.versions.electron) return nodeFs;
  const runtimeRequire = createRequire(path.join(process.cwd(), '__cos_skills_runtime__.cjs'));
  return runtimeRequire('original-fs') as typeof nodeFs;
})();

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalRealpath(target: string): Promise<string> {
  return process.platform === 'win32' ? rawRealpathNative(target) : fs.realpath(target);
}

function canonicalRealpathSync(target: string): string {
  return process.platform === 'win32' ? rawSyncFs.realpathSync.native(target) : rawSyncFs.realpathSync(target);
}

function fsErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
  if (a.dev !== 0 && b.dev !== 0 && a.ino !== 0 && b.ino !== 0) return a.dev === b.dev && a.ino === b.ino;
  return a.isFile() === b.isFile() && a.isDirectory() === b.isDirectory();
}

function homeDirectory(): string {
  const configured = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return path.resolve(configured || os.homedir());
}

function codexHomeDirectory(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDirectory(), '.codex');
}

function adminSkillsDirectory(): string {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData?.trim() || 'C:\\ProgramData';
    return path.join(programData, 'OpenAI', 'Codex', 'skills');
  }
  return '/etc/codex/skills';
}

function adminConfigFile(): string {
  return path.join(path.dirname(adminSkillsDirectory()), 'config.toml');
}

export function isSafeSkillId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > MAX_SKILL_ID_LENGTH || !SKILL_ID_PATTERN.test(id)) return false;
  return !RESERVED_SKILL_ID_SET.has(id) && !WINDOWS_RESERVED_STEMS.has(id.split('.')[0]!.toLowerCase());
}

function requireSkillId(id: string): void {
  if (!isSafeSkillId(id)) throw new Error('Skill id must be a safe lower-case file name');
}

function skillIdFrom(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_SKILL_ID_LENGTH)
    .replace(/[._-]+$/g, '');
  if (!isSafeSkillId(normalized)) throw new Error('Skill name does not produce a safe skill id');
  return normalized;
}

function normalizeCommandBase(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_ID_LENGTH)
    .replace(/-+$/g, '');
  return normalized || 'skill';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function skillKey(file: string): string {
  return `file:${pathIdentity(file)}`;
}

async function requireRoot(): Promise<LibraryState> {
  const current = library;
  if (!current) throw new Error('Skill library is not initialized');
  let stat: Stats;
  try {
    stat = await fs.lstat(current.directory);
  } catch {
    throw new Error('Skill library directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill library directory is unsafe');
  let real: string;
  try {
    real = await canonicalRealpath(current.directory);
  } catch {
    throw new Error('Skill library directory is unavailable');
  }
  if (!samePath(real, current.directoryReal) || !isContained(current.userDataReal, real) || samePath(current.userDataReal, real)) {
    throw new Error('Skill library directory changed on disk');
  }
  return current;
}

/** Initialize the private managed directory. External Codex roots remain read-only. */
export async function initSkills(userData: string): Promise<void> {
  if (!path.isAbsolute(userData)) throw new Error('Skill userData path must be absolute');
  await mutations.catch(() => undefined);
  const userDataPath = path.resolve(userData);
  const directory = path.join(userDataPath, SKILLS_DIRECTORY_NAME);
  await fs.mkdir(directory, { recursive: true });
  const [userDataReal, directoryStat, directoryReal] = await Promise.all([
    canonicalRealpath(userDataPath),
    fs.lstat(directory),
    canonicalRealpath(directory),
  ]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Skill library directory is unsafe');
  if (!isContained(userDataReal, directoryReal) || samePath(userDataReal, directoryReal)) {
    throw new Error('Skill library must stay inside userData');
  }
  library = { directory, directoryReal, userDataReal };
}

export function skillsDirectory(): string | null {
  return library?.directoryReal ?? null;
}

export function isReadOnlySkillRoot(name: string): boolean {
  return READ_ONLY_ROOT_NAMES.has(name);
}

function syncExistingCanonicalDirectory(target: string): string | null {
  try {
    const lstat = rawSyncFs.lstatSync(target);
    const stat = lstat.isSymbolicLink() ? rawSyncFs.statSync(target) : lstat;
    if (!stat.isDirectory()) return null;
    return canonicalRealpathSync(target);
  } catch {
    return null;
  }
}

/** Global filesystem aliases. Repo-scoped roots are already reachable through the project root. */
export function standardSkillRoots(): Root[] {
  const roots: Root[] = [];
  if (library) {
    try {
      const stat = rawSyncFs.lstatSync(library.directory);
      const canonical = canonicalRealpathSync(library.directory);
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        samePath(canonical, library.directoryReal) &&
        isContained(library.userDataReal, canonical) &&
        !samePath(library.userDataReal, canonical)
      ) {
        roots.push({ name: 'skills', path: library.directoryReal });
      }
    } catch {
      // A replaced/unavailable managed root is omitted until requireRoot can validate it again.
    }
  }
  const candidates: Array<[string, string]> = [
    ['skill-user', path.join(homeDirectory(), '.agents', 'skills')],
    ['skill-codex', path.join(codexHomeDirectory(), 'skills')],
    ['skill-system', path.join(codexHomeDirectory(), 'skills', '.system')],
    ['skill-admin', adminSkillsDirectory()],
  ];
  const seen = new Set<string>();
  for (const [name, candidate] of candidates) {
    const canonical = syncExistingCanonicalDirectory(candidate);
    if (!canonical) continue;
    const identity = pathIdentity(canonical);
    if (seen.has(identity) || roots.some(root => samePath(canonical!, root.path))) continue;
    seen.add(identity);
    roots.push({ name, path: canonical });
  }
  return roots;
}

async function readBoundedUtf8(file: string, expected?: Stats, maxBytes = MAX_SKILL_BYTES): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Skill content must be a regular file');
    if (expected && !sameFileIdentity(expected, opened)) throw new Error('Skill content changed during access');
    if (opened.size > maxBytes) throw new Error(`Skill content exceeds the ${maxBytes} byte limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > maxBytes) throw new Error(`Skill content exceeds the ${maxBytes} byte limit`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error('Skill content is not valid UTF-8');
    }
    if (BINARY_CONTROL_CHARS.test(text)) throw new Error('Skill content looks binary or contains control bytes');
    return text;
  } finally {
    await handle.close();
  }
}

async function readBoundedBytes(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Skill package content must be a regular file');
    if (opened.size > maxBytes) throw new Error(`Skill package exceeds ${MAX_SKILL_PACKAGE_BYTES} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > maxBytes) throw new Error(`Skill package exceeds ${MAX_SKILL_PACKAGE_BYTES} bytes`);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function stripYamlComment(value: string): string {
  let quoted: 'single' | 'double' | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "'" && quoted !== 'double') {
      if (quoted === 'single' && value[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = quoted === 'single' ? null : 'single';
    } else if (char === '"' && quoted !== 'single' && value[i - 1] !== '\\') {
      quoted = quoted === 'double' ? null : 'double';
    } else if (char === '#' && quoted === null && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function yamlScalar(raw: string): string {
  const value = stripYamlComment(raw.trim()).trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function tomlInteger(raw: string): number | undefined {
  const value = stripYamlComment(raw.trim()).trim().replace(/_/g, '');
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function blockScalar(lines: string[], start: number, marker: string): { value: string; next: number } {
  const captured: string[] = [];
  let index = start;
  let minIndent = Number.POSITIVE_INFINITY;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === '') {
      captured.push('');
      continue;
    }
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent === 0) break;
    minIndent = Math.min(minIndent, indent);
    captured.push(line);
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  const normalized = captured.map(line => line === '' ? '' : line.slice(minIndent));
  let value: string;
  if (marker.startsWith('>')) {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of normalized) {
      if (line === '') {
        if (current.length) paragraphs.push(current.join(' '));
        current = [];
      } else current.push(line.trim());
    }
    if (current.length) paragraphs.push(current.join(' '));
    value = paragraphs.join('\n\n');
  } else value = normalized.join('\n');
  if (!marker.endsWith('-') && value && normalized.length > 0) value += '\n';
  return { value, next: index };
}

function parseFrontmatter(text: string): Frontmatter {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { exists: false, body: source };
  let close = -1;
  for (let i = 1; i < Math.min(lines.length, 129); i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i]!)) {
      close = i;
      break;
    }
  }
  if (close < 0) return { exists: false, body: source };

  let name: string | undefined;
  let description: string | undefined;
  let shortDescription: string | undefined;
  let metadataIndent: number | null = null;
  for (let i = 1; i < close;) {
    const line = lines[i]!;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (metadataIndent !== null && indent > metadataIndent) {
      const nested = /^\s*short-description\s*:\s*(.*)$/i.exec(line);
      if (nested && shortDescription === undefined) shortDescription = yamlScalar(nested[1]!);
      i++;
      continue;
    }
    metadataIndent = null;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    if (key === 'metadata' && raw.trim() === '') {
      metadataIndent = indent;
      i++;
      continue;
    }
    if ((key === 'name' || key === 'description') && /^[>|][+-]?$/.test(raw.trim())) {
      const parsed = blockScalar(lines.slice(0, close), i + 1, raw.trim());
      if (key === 'name' && name === undefined) name = parsed.value;
      if (key === 'description' && description === undefined) description = parsed.value;
      i = parsed.next;
      continue;
    }
    if (key === 'name' && name === undefined) name = yamlScalar(raw);
    if (key === 'description' && description === undefined) description = yamlScalar(raw);
    i++;
  }
  return { exists: true, body: lines.slice(close + 1).join('\n'), name, description, shortDescription };
}

function cleanName(value: string | undefined, max = MAX_SKILL_NAME_CHARS): string | undefined {
  if (value === undefined) return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) return undefined;
  if (name.length > max) throw new Error(`Skill name exceeds ${max} characters`);
  if (BINARY_CONTROL_CHARS.test(name)) throw new Error('Skill name contains control characters');
  return name;
}

function cleanDescription(value: string | undefined, max = MAX_SKILL_DESCRIPTION_CHARS): string | undefined {
  if (value === undefined) return undefined;
  const description = value.replace(/\r\n/g, '\n').trim();
  if (!description) return undefined;
  if (description.length > max) throw new Error(`Skill description exceeds ${max} characters`);
  if (BINARY_CONTROL_CHARS.test(description)) throw new Error('Skill description contains control characters');
  return description;
}

function markdownTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return cleanName(match[1]);
  }
  return undefined;
}

function bodyDescription(body: string): string {
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```|^~~~/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^#{1,6}(?:\s|$)/.test(line)) continue;
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) return '';
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_SKILL_DESCRIPTION_CHARS ? text : `${text.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** Managed parser intentionally accepts legacy plain Markdown/text imports. */
function parseManagedSkill(text: string, fallbackName: string): ParsedSkill {
  const frontmatter = parseFrontmatter(text);
  const metadataName = cleanName(frontmatter.name);
  const title = metadataName ? undefined : markdownTitle(frontmatter.body);
  const fallback = cleanName(fallbackName);
  const name = metadataName ?? title ?? fallback;
  if (!name) throw new Error('Skill needs a name, Markdown title, or usable file name');
  return {
    name,
    description: cleanDescription(frontmatter.description) ?? bodyDescription(frontmatter.body),
    nameSource: metadataName ? 'frontmatter' : title ? 'title' : 'fallback',
    frontmatter,
  };
}

/** External Codex skills require SKILL.md frontmatter and a description. */
function parseExternalSkill(text: string, fallbackName: string): ParsedSkill {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.exists) throw new Error('missing YAML frontmatter delimited by ---');
  const name = cleanName(frontmatter.name, MAX_EXTERNAL_SKILL_NAME_CHARS)
    ?? cleanName(fallbackName, MAX_EXTERNAL_SKILL_NAME_CHARS);
  if (!name) throw new Error('missing field `name`');
  const description = cleanDescription(frontmatter.description, MAX_EXTERNAL_SKILL_DESCRIPTION_CHARS);
  if (!description) throw new Error('missing field `description`');
  return { name, description, nameSource: frontmatter.name ? 'frontmatter' : 'fallback', frontmatter };
}

function sourceFallbackName(source: string): string {
  const extension = path.extname(source);
  const stem = path.basename(source, extension).trim();
  if (stem.toLowerCase() !== 'skill') return stem || 'skill';
  return path.basename(path.dirname(source)).trim() || 'skill';
}

function stabilizeFallbackName(text: string, parsed: ParsedSkill): string {
  if (parsed.nameSource !== 'fallback') return text;
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const nameLine = `name: ${JSON.stringify(parsed.name)}${eol}`;
  if (parsed.frontmatter.exists && source.startsWith('---')) {
    const firstBreak = source.indexOf('\n');
    if (firstBreak >= 0) return bom + source.slice(0, firstBreak + 1) + nameLine + source.slice(firstBreak + 1);
  }
  return `${bom}---${eol}${nameLine}---${eol}${source}`;
}

function parseBooleanScalar(raw: string): boolean | undefined {
  const value = yamlScalar(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Minimal fail-open parser for the Codex-owned agents/openai.yaml surface. */
function parseOpenAiMetadata(text: string): OpenAiMetadata {
  const result: OpenAiMetadata = {};
  const dependencies: SkillDependency[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let section = '';
  let inTools = false;
  let currentDependency: Partial<SkillDependency> | null = null;

  const commitDependency = (): void => {
    if (currentDependency?.type && currentDependency.value) dependencies.push(currentDependency as SkillDependency);
    currentDependency = null;
  };

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent === 0) {
      commitDependency();
      inTools = false;
      const top = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(line);
      section = top?.[1]?.toLowerCase() ?? '';
      continue;
    }
    if (section === 'interface') {
      const match = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = yamlScalar(match[2]!);
      if (!value) continue;
      if (match[1] === 'display_name') result.displayName = value.replace(/\s+/g, ' ').trim();
      else if (match[1] === 'short_description') result.shortDescription = value.replace(/\s+/g, ' ').trim();
      else if (match[1] === 'default_prompt') result.defaultPrompt = value.trim();
      continue;
    }
    if (section === 'policy') {
      const match = /^\s+allow_implicit_invocation\s*:\s*(.*)$/i.exec(line);
      if (match) result.allowImplicitInvocation = parseBooleanScalar(match[1]!);
      continue;
    }
    if (section !== 'dependencies') continue;
    if (/^\s+tools\s*:\s*$/.test(line)) {
      inTools = true;
      continue;
    }
    if (!inTools) continue;
    const first = /^\s*-\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (first) {
      commitDependency();
      currentDependency = {};
      const key = first[1]!;
      const value = yamlScalar(first[2]!);
      if (key === 'type') currentDependency.type = value;
      else if (key === 'value') currentDependency.value = value;
      continue;
    }
    const field = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!field || !currentDependency) continue;
    const value = yamlScalar(field[2]!);
    if (field[1] === 'type') currentDependency.type = value;
    else if (field[1] === 'value') currentDependency.value = value;
    else if (field[1] === 'description' && value) currentDependency.description = value;
    else if (field[1] === 'transport' && value) currentDependency.transport = value;
    else if (field[1] === 'command' && value) currentDependency.command = value;
    else if (field[1] === 'url' && value) currentDependency.url = value;
    else if (field[1] === 'callback_port' && /^\d+$/.test(value)) currentDependency.oauthCallbackPort = Number(value);
  }
  commitDependency();
  if (dependencies.length) result.dependencies = dependencies;
  return result;
}

async function loadOptionalOpenAiMetadata(skillDirectory: string): Promise<OpenAiMetadata> {
  const file = path.join(skillDirectory, 'agents', 'openai.yaml');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return {};
    return parseOpenAiMetadata(await readBoundedUtf8(file, stat, 64 * 1024));
  } catch {
    return {};
  }
}

async function inspectManagedSkill(id: string): Promise<ManagedSkill> {
  requireSkillId(id);
  const root = await requireRoot();
  const directory = path.join(root.directory, id);
  if (!isContained(root.directory, directory)) throw new Error('Skill path escapes the library');
  let directoryStat: Stats;
  try {
    directoryStat = await fs.lstat(directory);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') throw new Error(`Skill "${id}" was not found`);
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Skill "${id}" directory is unsafe`);
  const directoryReal = await canonicalRealpath(directory);
  if (!isContained(root.directoryReal, directoryReal) || samePath(root.directoryReal, directoryReal)) {
    throw new Error(`Skill "${id}" directory escapes the library`);
  }
  const file = path.join(directory, SKILL_FILE_NAME);
  let fileStat: Stats;
  try {
    fileStat = await fs.lstat(file);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') throw new Error(`Skill "${id}" is missing ${SKILL_FILE_NAME}`);
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Skill "${id}" ${SKILL_FILE_NAME} is unsafe`);
  const fileReal = await canonicalRealpath(file);
  if (!isContained(directoryReal, fileReal) || !isContained(root.directoryReal, fileReal)) {
    throw new Error(`Skill "${id}" ${SKILL_FILE_NAME} escapes the library`);
  }
  return { directory, directoryReal, directoryStat, file, fileStat };
}

function rootSummary(root: DiscoveryRoot): SkillRootSummary {
  const { name, path: rootPath, scope, source, managed, readOnly } = root;
  return { name, path: rootPath, scope, source, managed, readOnly };
}

async function findRepoRoot(projectPath: string): Promise<string> {
  let current = await canonicalRealpath(projectPath).catch(() => path.resolve(projectPath));
  while (true) {
    try {
      await fs.lstat(path.join(current, '.git'));
      return current;
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return await canonicalRealpath(projectPath).catch(() => path.resolve(projectPath));
    current = parent;
  }
}

function directoriesBetween(root: string, leaf: string): string[] {
  const values: string[] = [];
  let current = path.resolve(leaf);
  const rootIdentity = pathIdentity(root);
  while (true) {
    values.push(current);
    if (pathIdentity(current) === rootIdentity) break;
    const parent = path.dirname(current);
    if (parent === current || !isContained(root, current)) return [path.resolve(leaf)];
    current = parent;
  }
  values.reverse();
  return values;
}

async function canonicalDirectoryIfExists(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return null;
    return canonicalRealpath(target);
  } catch { return null; }
}

function emptySkillConfigLayer(): ParsedSkillConfigLayer {
  return { rules: [] };
}

function parseSkillConfigLayer(text: string, configFile: string): ParsedSkillConfigLayer {
  const result = emptySkillConfigLayer();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let section: 'skills' | 'bundled' | 'rule' | 'other' = 'other';
  let currentRule: { name?: string; path?: string; enabled?: boolean } | null = null;

  const commitRule = (): void => {
    if (!currentRule) return;
    const selectors = Number(currentRule.name !== undefined) + Number(currentRule.path !== undefined);
    if (selectors === 1 && currentRule.enabled !== undefined) {
      if (currentRule.name !== undefined) {
        const name = currentRule.name.replace(/\s+/g, ' ').trim();
        if (name) result.rules.push({ selector: 'name', value: name, enabled: currentRule.enabled });
      } else if (currentRule.path !== undefined) {
        const rawPath = currentRule.path.trim();
        if (rawPath) {
          const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(path.dirname(configFile), rawPath);
          result.rules.push({ selector: 'path', value: resolved, enabled: currentRule.enabled });
        }
      }
    }
    currentRule = null;
  };

  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine).trim();
    if (!line) continue;
    if (line === '[[skills.config]]') {
      commitRule();
      currentRule = {};
      section = 'rule';
      continue;
    }
    if (/^\[.*\]$/.test(line)) {
      commitRule();
      section = line === '[skills]' ? 'skills' : line === '[skills.bundled]' ? 'bundled' : 'other';
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!;
    const raw = assignment[2]!;
    if (section === 'skills') {
      if (key === 'include_instructions') {
        const value = parseBooleanScalar(raw);
        if (value !== undefined) result.includeInstructions = value;
      } else if (key === 'max_context_tokens') {
        const value = tomlInteger(raw);
        if (value !== undefined) result.maxContextTokens = value;
      }
      continue;
    }
    if (section === 'bundled') {
      if (key === 'enabled') {
        const value = parseBooleanScalar(raw);
        if (value !== undefined) result.bundledEnabled = value;
      }
      continue;
    }
    if (section !== 'rule' || !currentRule) continue;
    if (key === 'name') currentRule.name = yamlScalar(raw);
    else if (key === 'path') currentRule.path = yamlScalar(raw);
    else if (key === 'enabled') currentRule.enabled = parseBooleanScalar(raw);
  }
  commitRule();
  return result;
}

async function loadSkillConfigFile(file: string): Promise<ParsedSkillConfigLayer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return parseSkillConfigLayer(await readBoundedUtf8(file, undefined, MAX_SKILLS_CONFIG_BYTES), file);
  } catch {
    return null;
  }
}

async function canonicalRulePath(value: string): Promise<string> {
  return canonicalRealpath(value).catch(() => path.resolve(value));
}

async function effectiveSkillConfig(options: SkillScopeOptions): Promise<EffectiveSkillConfig> {
  const files: string[] = [adminConfigFile(), path.join(codexHomeDirectory(), 'config.toml')];
  const projectPath = options.projectPath?.trim();
  if (projectPath) {
    if (!path.isAbsolute(projectPath)) throw new Error('Skill projectPath must be absolute');
    const scoped = await canonicalDirectoryIfExists(projectPath);
    if (!scoped) throw new Error('Skill projectPath is unavailable');
    const repoRoot = await findRepoRoot(scoped);
    for (const directory of directoriesBetween(repoRoot, scoped)) files.push(path.join(directory, '.codex', 'config.toml'));
  }

  const result: EffectiveSkillConfig = { includeInstructions: true, bundledEnabled: true, rules: [] };
  for (const file of files) {
    const layer = await loadSkillConfigFile(file);
    if (!layer) continue;
    if (layer.includeInstructions !== undefined) result.includeInstructions = layer.includeInstructions;
    if (layer.maxContextTokens !== undefined) result.maxContextTokens = layer.maxContextTokens;
    if (layer.bundledEnabled !== undefined) result.bundledEnabled = layer.bundledEnabled;
    for (const rule of layer.rules) {
      result.rules.push(rule.selector === 'path'
        ? { ...rule, value: await canonicalRulePath(rule.value) }
        : rule);
    }
  }
  return result;
}

async function discoveryRoots(options: SkillScopeOptions, config: EffectiveSkillConfig): Promise<DiscoveryRoot[]> {
  const managed = await requireRoot();
  const candidates: Omit<DiscoveryRoot, 'order'>[] = [{
    name: 'skills', path: managed.directoryReal, scope: 'managed', source: 'managed', managed: true, readOnly: false,
  }];
  const projectPath = options.projectPath?.trim();
  if (projectPath) {
    if (!path.isAbsolute(projectPath)) throw new Error('Skill projectPath must be absolute');
    const scoped = await canonicalDirectoryIfExists(projectPath);
    if (!scoped) throw new Error('Skill projectPath is unavailable');
    const repoRoot = await findRepoRoot(scoped);
    for (const [index, directory] of directoriesBetween(repoRoot, scoped).entries()) {
      candidates.push({
        name: `repo-agents-${index}`, path: path.join(directory, '.agents', 'skills'), scope: 'repo', source: 'repo-agents', managed: false, readOnly: true,
      });
    }
    candidates.push({
      name: 'project-codex', path: path.join(scoped, '.codex', 'skills'), scope: 'repo', source: 'project-codex', managed: false, readOnly: true,
    });
  }
  candidates.push(
    { name: 'skill-user', path: path.join(homeDirectory(), '.agents', 'skills'), scope: 'user', source: 'user-agents', managed: false, readOnly: true },
    { name: 'skill-codex', path: path.join(codexHomeDirectory(), 'skills'), scope: 'user', source: 'codex-home', managed: false, readOnly: true },
    { name: 'skill-admin', path: adminSkillsDirectory(), scope: 'admin', source: 'admin', managed: false, readOnly: true },
  );
  if (config.bundledEnabled) {
    candidates.push({ name: 'skill-system', path: path.join(codexHomeDirectory(), 'skills', '.system'), scope: 'system', source: 'bundled', managed: false, readOnly: true });
  }

  const roots: DiscoveryRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let canonical: string | null;
    if (candidate.managed) canonical = candidate.path;
    else {
      if (candidate.scope === 'system') {
        try {
          if ((await fs.lstat(candidate.path)).isSymbolicLink()) continue;
        } catch {}
      }
      canonical = await canonicalDirectoryIfExists(candidate.path);
    }
    if (!canonical) continue;
    const identity = pathIdentity(canonical);
    if (seen.has(identity)) continue;
    seen.add(identity);
    roots.push({ ...candidate, path: canonical, order: roots.length });
  }
  return roots;
}

function baseSummary(
  root: DiscoveryRoot,
  fileReal: string,
  parsed: ParsedSkill,
  metadata: OpenAiMetadata,
  managedId?: string,
): SkillSummary {
  return {
    id: managedId ?? normalizeCommandBase(parsed.name),
    ...(managedId ? { managedId } : {}),
    key: skillKey(fileReal),
    command: '',
    name: parsed.name,
    description: parsed.description,
    ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    ...(metadata.shortDescription || parsed.frontmatter.shortDescription
      ? { shortDescription: metadata.shortDescription ?? parsed.frontmatter.shortDescription }
      : {}),
    ...(metadata.defaultPrompt ? { defaultPrompt: metadata.defaultPrompt } : {}),
    ...(metadata.dependencies?.length ? { dependencies: metadata.dependencies } : {}),
    scope: root.scope,
    source: root.source,
    managed: root.managed,
    allowImplicitInvocation: metadata.allowImplicitInvocation ?? true,
  };
}

async function loadManagedRecords(root: DiscoveryRoot, addError: (message: string) => void): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  const entries: string[] = [];
  let entryCount = 0;
  for await (const entry of await fs.opendir(root.path)) {
    entryCount++;
    if (entryCount > MAX_SKILL_DIRECTORY_ENTRIES) {
      addError(`Skill directory has more than ${MAX_SKILL_DIRECTORY_ENTRIES} entries; remaining entries were not scanned`);
      break;
    }
    entries.push(entry.name);
  }
  entries.sort((a, b) => a.localeCompare(b));
  let skillLimitReported = false;
  for (const id of entries) {
    if (!isSafeSkillId(id)) {
      addError(`Unsafe or unsupported skill entry "${id}"`);
      continue;
    }
    if (records.length >= MAX_SKILLS) {
      if (!skillLimitReported) {
        addError(`Skill library contains more than ${MAX_SKILLS} readable skills; remaining skills were not loaded`);
        skillLimitReported = true;
      }
      continue;
    }
    try {
      const managed = await inspectManagedSkill(id);
      const text = await readBoundedUtf8(managed.file, managed.fileStat);
      const parsed = parseManagedSkill(text, id);
      const metadata = await loadOptionalOpenAiMetadata(managed.directoryReal);
      const fileReal = await canonicalRealpath(managed.file);
      records.push({
        summary: baseSummary(root, fileReal, parsed, metadata, id),
        file: fileReal,
        directory: managed.directoryReal,
        managedId: id,
      });
    } catch (error) {
      addError(`${id}: ${errorText(error)}`);
    }
  }
  return records;
}

async function fileKind(target: string): Promise<{ stat: Stats; real: string } | null> {
  try {
    const lstat = await fs.lstat(target);
    const stat = lstat.isSymbolicLink() ? await fs.stat(target) : lstat;
    return { stat, real: await canonicalRealpath(target) };
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function loadExternalRecords(root: DiscoveryRoot, addError: (message: string) => void): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root.path, depth: 0 }];
  const seenDirectories = new Set<string>();
  let scannedDirectories = 0;
  let scannedEntries = 0;

  while (queue.length) {
    const current = queue.shift()!;
    let currentReal: string;
    try {
      currentReal = await canonicalRealpath(current.directory);
    } catch (error) {
      addError(`${root.name}: ${errorText(error)}`);
      continue;
    }
    const directoryIdentity = pathIdentity(currentReal);
    if (seenDirectories.has(directoryIdentity)) continue;
    seenDirectories.add(directoryIdentity);
    scannedDirectories++;
    if (scannedDirectories > MAX_SKILL_SCAN_DIRECTORIES) {
      addError(`${root.name}: skills scan reached ${MAX_SKILL_SCAN_DIRECTORIES} directories; remaining paths were not scanned`);
      break;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      addError(`${root.name}: failed to scan ${current.directory}: ${errorText(error)}`);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      scannedEntries++;
      if (scannedEntries > MAX_SKILL_SCAN_ENTRIES) {
        addError(`${root.name}: skills scan reached ${MAX_SKILL_SCAN_ENTRIES} entries; remaining paths were not scanned`);
        return records;
      }
      const target = path.join(current.directory, entry.name);
      if (entry.name === SKILL_FILE_NAME) {
        try {
          if (root.scope === 'system' && entry.isSymbolicLink()) continue;
          const kind = await fileKind(target);
          if (!kind?.stat.isFile()) continue;
          if (!isContained(currentReal, kind.real)) {
            addError(`${root.name}: linked ${SKILL_FILE_NAME} escapes its canonical skill directory and was ignored`);
            continue;
          }
          const text = await readBoundedUtf8(target);
          const parsed = parseExternalSkill(text, path.basename(current.directory));
          const directoryReal = path.dirname(kind.real);
          const metadata = await loadOptionalOpenAiMetadata(current.directory);
          records.push({
            summary: baseSummary(root, kind.real, parsed, metadata),
            file: kind.real,
            directory: directoryReal,
          });
        } catch (error) {
          addError(`${target}: ${errorText(error)}`);
        }
        continue;
      }
      if (entry.name.startsWith('.') || current.depth >= MAX_SKILL_SCAN_DEPTH) continue;
      try {
        if (root.scope === 'system' && entry.isSymbolicLink()) continue;
        const kind = await fileKind(target);
        if (kind?.stat.isDirectory() && !seenDirectories.has(pathIdentity(kind.real))) {
          queue.push({ directory: target, depth: current.depth + 1 });
        }
      } catch (error) {
        addError(`${target}: ${errorText(error)}`);
      }
    }
  }
  return records;
}

function recordEnabled(record: SkillRecord, config: EffectiveSkillConfig): boolean {
  let enabled = true;
  for (const rule of config.rules) {
    const matches = rule.selector === 'name'
      ? record.summary.name === rule.value
      : samePath(record.file, rule.value);
    if (matches) enabled = rule.enabled;
  }
  return enabled;
}

function assignCommands(records: SkillRecord[]): void {
  const bases = new Map<string, number>();
  const baseFor = new Map<string, string>();
  for (const record of records) {
    const base = record.managedId ?? normalizeCommandBase(record.summary.name);
    baseFor.set(record.summary.key, base);
    bases.set(base, (bases.get(base) ?? 0) + 1);
  }
  const used = new Set<string>();
  for (const record of records) {
    const base = baseFor.get(record.summary.key)!;
    const uniqueBare = (bases.get(base) ?? 0) === 1 && isSafeSkillId(base) && !used.has(base);
    let token = base;
    if (!uniqueBare) {
      const qualifier = `${record.summary.scope}-${stableHash(record.summary.key)}`;
      const maxBase = Math.max(1, MAX_SKILL_ID_LENGTH - qualifier.length - 2);
      token = `${base.slice(0, maxBase).replace(/-+$/g, '') || 'skill'}--${qualifier}`;
      let suffix = 2;
      const initial = token;
      while (used.has(token)) {
        const suffixText = `-${suffix++}`;
        token = `${initial.slice(0, MAX_SKILL_ID_LENGTH - suffixText.length)}${suffixText}`;
      }
    }
    used.add(token);
    record.summary.command = `/${token}`;
    if (!record.managedId) record.summary.id = token;
  }
}

async function discoverSkills(options: SkillScopeOptions = {}): Promise<DiscoveryResult> {
  const config = await effectiveSkillConfig(options);
  const roots = await discoveryRoots(options, config);
  const rawErrors: string[] = [];
  let omittedErrors = 0;
  const addError = (message: string): void => {
    if (rawErrors.length < MAX_SKILL_ERRORS - 1) rawErrors.push(message);
    else omittedErrors++;
  };
  const records: SkillRecord[] = [];
  const seenSkills = new Set<string>();
  for (const root of roots) {
    let loaded: SkillRecord[];
    try {
      loaded = root.managed ? await loadManagedRecords(root, addError) : await loadExternalRecords(root, addError);
    } catch (error) {
      addError(`${root.name}: ${errorText(error)}`);
      continue;
    }
    for (const record of loaded) {
      if (records.length >= MAX_DISCOVERED_SKILLS) {
        addError(`Skill catalog contains more than ${MAX_DISCOVERED_SKILLS} skills; remaining skills were not loaded`);
        break;
      }
      if (seenSkills.has(record.summary.key) || !recordEnabled(record, config)) continue;
      seenSkills.add(record.summary.key);
      records.push(record);
    }
  }
  assignCommands(records);
  if (omittedErrors > 0) rawErrors.push(`${omittedErrors} additional skill errors omitted by the ${MAX_SKILL_ERRORS} error limit`);
  return { records, roots, errors: rawErrors, config };
}

/** Re-read every applicable root each call so model-created skills appear without app restart. */
export async function listSkills(options: SkillScopeOptions = {}): Promise<SkillLibrary> {
  const state = library;
  if (!state) throw new Error('Skill library is not initialized');
  const discovered = await discoverSkills(options);
  return {
    directory: state.directory,
    skills: discovered.records.map(record => ({ ...record.summary })),
    errors: discovered.errors,
    roots: discovered.roots.map(rootSummary),
    includeInstructions: discovered.config.includeInstructions,
    ...(discovered.config.maxContextTokens !== undefined ? { maxContextTokens: discovered.config.maxContextTokens } : {}),
  };
}

function normalizeCommandReference(reference: string): string {
  const trimmed = reference.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export async function readSkill(
  reference: string,
  options: SkillScopeOptions & { by?: 'key' | 'command' } = {},
): Promise<SkillSummary & { text: string; file: string; directory: string }> {
  const discovered = await discoverSkills(options);
  let record: SkillRecord | undefined;
  if (options.by === 'key') record = discovered.records.find(candidate => candidate.summary.key === reference);
  else if (options.by === 'command') {
    const command = normalizeCommandReference(reference);
    record = discovered.records.find(candidate => candidate.summary.command === command);
  } else {
    record = discovered.records.find(candidate => candidate.managedId === reference)
      ?? discovered.records.find(candidate => candidate.summary.key === reference)
      ?? discovered.records.find(candidate => candidate.summary.command === normalizeCommandReference(reference));
  }
  if (!record) throw new Error(`Skill "${reference}" was not found in the current scope`);
  let currentReal: string;
  try {
    currentReal = await canonicalRealpath(record.file);
  } catch {
    throw new Error(`Skill "${reference}" changed or is unavailable`);
  }
  if (skillKey(currentReal) !== record.summary.key) throw new Error(`Skill "${reference}" changed during access`);
  const text = await readBoundedUtf8(record.file);
  return { ...record.summary, text, file: currentReal, directory: path.dirname(currentReal) };
}

function queueMutation<T>(work: () => Promise<T>): Promise<T> {
  const operation = mutations.then(work);
  mutations = operation.catch(() => undefined);
  return operation;
}

async function installedManagedSummary(id: string): Promise<SkillSummary> {
  const managed = await inspectManagedSkill(id);
  const text = await readBoundedUtf8(managed.file, managed.fileStat);
  const parsed = parseManagedSkill(text, id);
  const metadata = await loadOptionalOpenAiMetadata(managed.directoryReal);
  const root: DiscoveryRoot = {
    name: 'skills', path: (await requireRoot()).directoryReal, scope: 'managed', source: 'managed', managed: true, readOnly: false, order: 0,
  };
  const fileReal = await canonicalRealpath(managed.file);
  const record: SkillRecord = {
    summary: baseSummary(root, fileReal, parsed, metadata, id),
    file: fileReal,
    directory: managed.directoryReal,
    managedId: id,
  };
  assignCommands([record]);
  return record.summary;
}

/** Import one user-selected Markdown/text file into the managed library. */
export function importSkillFile(source: string): Promise<SkillSummary> {
  return queueMutation(async () => {
    if (!path.isAbsolute(source)) throw new Error('Choose an absolute skill file path');
    const extension = path.extname(source).toLowerCase();
    if (extension !== '.md' && extension !== '.txt') throw new Error('Skill import accepts only .md or .txt files');
    const sourceText = await readBoundedUtf8(source);
    const parsed = parseManagedSkill(sourceText, sourceFallbackName(source));
    const id = skillIdFrom(parsed.name);
    const storedText = stabilizeFallbackName(sourceText, parsed);
    if (Buffer.byteLength(storedText, 'utf8') > MAX_SKILL_BYTES) throw new Error(`Normalized skill content exceeds the ${MAX_SKILL_BYTES} byte limit`);

    const root = await requireRoot();
    const targetDirectory = path.join(root.directory, id);
    let createdDirectory = false;
    let createdDirectoryStat: Stats | null = null;
    try {
      try {
        await fs.mkdir(targetDirectory);
        createdDirectory = true;
      } catch (error) {
        if (fsErrorCode(error) === 'EEXIST') throw new Error(`Skill "${id}" already exists`);
        throw error;
      }
      const directoryStat = await fs.lstat(targetDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('New skill directory is unsafe');
      createdDirectoryStat = directoryStat;
      const directoryReal = await canonicalRealpath(targetDirectory);
      if (!isContained(root.directoryReal, directoryReal)) throw new Error('New skill directory escapes the library');
      const targetFile = path.join(targetDirectory, SKILL_FILE_NAME);
      await fs.writeFile(targetFile, storedText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return installedManagedSummary(id);
    } catch (error) {
      if (createdDirectory) {
        try {
          const directoryNow = await fs.lstat(targetDirectory);
          if (createdDirectoryStat && directoryNow.isDirectory() && !directoryNow.isSymbolicLink() && sameFileIdentity(createdDirectoryStat, directoryNow)) {
            const targetFile = path.join(targetDirectory, SKILL_FILE_NAME);
            try {
              const stat = await fs.lstat(targetFile);
              if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(targetFile);
            } catch {}
            try { await fs.rmdir(targetDirectory); } catch {}
          }
        } catch {}
      }
      throw error;
    }
  });
}

/** Import either a complete package directory or one legacy Markdown/text skill file. */
export async function importSkill(source: string): Promise<SkillSummary> {
  if (!path.isAbsolute(source)) throw new Error('Choose an absolute skill path');
  const stat = await fs.lstat(source);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return importSkillPackage(source);
  if (stat.isFile() && !stat.isSymbolicLink()) return importSkillFile(source);
  throw new Error('Skill import source must be a real directory or Markdown/text file');
}

interface PackageCopyState {
  rootReal: string;
  entries: number;
  bytes: number;
  activeDirectories: Set<string>;
  createdFiles: Array<{ path: string; stat: Stats }>;
  createdDirectories: Array<{ path: string; stat: Stats }>;
}

async function copyPackageEntry(source: string, destination: string, state: PackageCopyState, depth = 0): Promise<void> {
  if (depth > 32) throw new Error('Skill package nesting is too deep');
  state.entries++;
  if (state.entries > MAX_SKILL_PACKAGE_ENTRIES) throw new Error(`Skill package exceeds ${MAX_SKILL_PACKAGE_ENTRIES} entries`);
  const lstat = await fs.lstat(source);
  let effectiveSource = source;
  let stat = lstat;
  if (lstat.isSymbolicLink()) {
    const real = await canonicalRealpath(source);
    if (!isContained(state.rootReal, real)) throw new Error(`Skill package link escapes the selected package: ${source}`);
    effectiveSource = real;
    stat = await fs.stat(real);
  }
  if (stat.isDirectory()) {
    const real = await canonicalRealpath(effectiveSource);
    const identity = pathIdentity(real);
    if (state.activeDirectories.has(identity)) throw new Error(`Skill package contains a directory link cycle: ${source}`);
    state.activeDirectories.add(identity);
    await fs.mkdir(destination, { mode: 0o700 });
    const created = await fs.lstat(destination);
    state.createdDirectories.push({ path: destination, stat: created });
    const entries = await fs.readdir(effectiveSource, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) await copyPackageEntry(path.join(effectiveSource, entry.name), path.join(destination, entry.name), state, depth + 1);
    state.activeDirectories.delete(identity);
    return;
  }
  if (!stat.isFile()) throw new Error(`Skill package contains unsupported entry: ${source}`);
  const remainingBytes = MAX_SKILL_PACKAGE_BYTES - state.bytes;
  const data = await readBoundedBytes(effectiveSource, remainingBytes);
  state.bytes += data.length;
  await fs.writeFile(destination, data, { flag: 'wx', mode: 0o600 });
  state.createdFiles.push({ path: destination, stat: await fs.lstat(destination) });
}

async function cleanupPackageCopy(state: PackageCopyState): Promise<void> {
  for (const file of state.createdFiles.reverse()) {
    try {
      const now = await fs.lstat(file.path);
      if (now.isFile() && !now.isSymbolicLink() && sameFileIdentity(file.stat, now)) await fs.unlink(file.path);
    } catch {}
  }
  for (const directory of state.createdDirectories.reverse()) {
    try {
      const now = await fs.lstat(directory.path);
      if (now.isDirectory() && !now.isSymbolicLink() && sameFileIdentity(directory.stat, now)) await fs.rmdir(directory.path);
    } catch {}
  }
}

/** Copy a complete Codex skill package into the managed library without preserving symlinks. */
export function importSkillPackage(sourceDirectory: string): Promise<SkillSummary> {
  return queueMutation(async () => {
    if (!path.isAbsolute(sourceDirectory)) throw new Error('Choose an absolute skill package directory');
    const sourceLstat = await fs.lstat(sourceDirectory);
    if (!sourceLstat.isDirectory() || sourceLstat.isSymbolicLink()) throw new Error('Skill package source must be a real directory');
    const sourceReal = await canonicalRealpath(sourceDirectory);
    const skillFile = path.join(sourceDirectory, SKILL_FILE_NAME);
    const skillStat = await fs.lstat(skillFile);
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error(`Skill package must contain a regular ${SKILL_FILE_NAME}`);
    const text = await readBoundedUtf8(skillFile, skillStat);
    const parsed = parseExternalSkill(text, path.basename(sourceDirectory));
    const id = skillIdFrom(parsed.name);
    const root = await requireRoot();
    const destination = path.join(root.directory, id);
    if (!isContained(root.directoryReal, destination)) throw new Error('Skill package destination escapes the managed library');
    try {
      await fs.lstat(destination);
      throw new Error(`Skill "${id}" already exists`);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') throw error;
    }
    const state: PackageCopyState = {
      rootReal: sourceReal,
      entries: 0,
      bytes: 0,
      activeDirectories: new Set(),
      createdFiles: [],
      createdDirectories: [],
    };
    try {
      await copyPackageEntry(sourceDirectory, destination, state);
      return installedManagedSummary(id);
    } catch (error) {
      await cleanupPackageCopy(state);
      throw error;
    }
  });
}

/** Remove only managed SKILL.md, then remove its directory only if nothing else is present. */
export function removeSkill(id: string): Promise<void> {
  return queueMutation(async () => {
    const managed = await inspectManagedSkill(id);
    const [directoryNow, fileNow] = await Promise.all([fs.lstat(managed.directory), fs.lstat(managed.file)]);
    if (
      directoryNow.isSymbolicLink() || !directoryNow.isDirectory() || !sameFileIdentity(managed.directoryStat, directoryNow) ||
      fileNow.isSymbolicLink() || !fileNow.isFile() || !sameFileIdentity(managed.fileStat, fileNow)
    ) throw new Error(`Skill "${id}" changed during removal`);
    await fs.unlink(managed.file);
    const after = await fs.lstat(managed.directory);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(directoryNow, after)) {
      throw new Error(`Skill "${id}" directory changed during removal`);
    }
    try {
      await fs.rmdir(managed.directory);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOTEMPTY' && fsErrorCode(error) !== 'EEXIST') throw error;
    }
  });
}
