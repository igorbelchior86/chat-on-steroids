import type { Root } from '../shared/types.js';
import {
  listSkills,
  skillsDirectory,
  standardSkillRoots,
  type SkillScopeOptions,
} from './skills.js';

const RESERVED_SKILL_ROOTS = new Set(['skills', 'skill-user', 'skill-codex', 'skill-system', 'skill-admin']);
const DEFAULT_SKILL_INDEX_MAX_CHARS = 8_000;
const MAX_SKILL_INDEX_CONTEXT_TOKENS = 10_000;
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Standard global skill directories join Core as read roots. Repo-scoped skills already live
 * beneath the user's approved project root and therefore need no extra filesystem authority.
 */
export function withSkillsRoot<T extends { roots: Root[] }>(context: T): T {
  const roots = context.roots.filter(root => !RESERVED_SKILL_ROOTS.has(root.name));
  return { ...context, roots: [...roots, ...standardSkillRoots()] };
}

/** Metadata is a directory index; skill bodies are loaded only when selected or read. */
export async function skillIndexInstructions(options: SkillScopeOptions = {}): Promise<string> {
  if (!skillsDirectory()) return '';
  const library = await listSkills(options);
  if (library.includeInstructions === false) return '';
  const configuredTokens = library.maxContextTokens === undefined
    ? null
    : Math.min(MAX_SKILL_INDEX_CONTEXT_TOKENS, Math.max(1, Math.floor(library.maxContextTokens)));
  const indexBudget = configuredTokens === null
    ? DEFAULT_SKILL_INDEX_MAX_CHARS
    : configuredTokens * APPROX_CHARS_PER_TOKEN;
  const lines = ['# Available skills',
    'Skills are Markdown instruction packages discovered from the managed /skills library and standard Codex locations, including project .agents/skills and .codex/skills, ~/.agents/skills, $CODEX_HOME/skills, bundled .system skills, and the platform admin directory when present.',
    'A package may contain SKILL.md plus agents/openai.yaml, scripts/, references/, assets/, and other supporting files. These files are inert resources: selecting a skill does not execute scripts, register tools, grant permissions, or enable plugins. Use only tools already available in this chat.',
    'Global standard skill roots exposed by Core are read-only. Repo skills remain inside the selected approved project. The managed /skills directory is the install destination for user-requested imports or model-created text skills.',
    'The user can explicitly select a skill through + → Skills, /prompt <command>, or its leading /command. A command always resolves to one exact discovered SKILL.md; name collisions receive qualified commands instead of silently choosing one copy.'];
  if (lines.join('\n').length > indexBudget) return '';
  const implicit = library.skills.filter(skill => skill.allowImplicitInvocation);
  const append = (line: string): boolean => {
    if ([...lines, line].join('\n').length > indexBudget) return false;
    lines.push(line);
    return true;
  };
  if (!library.skills.length) append('No skills are available in the current scope.');
  else if (!implicit.length) append('No skills permit implicit invocation. Explicit /commands remain available.');
  const omittedNotice = '(additional skills omitted from this bounded index; use + → Skills or type / to refresh the complete command list)';
  for (const [index, skill] of implicit.entries()) {
    const row = `- ${skill.command}: ${JSON.stringify((skill.shortDescription ?? skill.description).slice(0, 96))}`;
    const hasMore = index < implicit.length - 1;
    if (hasMore && [...lines, row, omittedNotice].join('\n').length > indexBudget) {
      append(omittedNotice);
      break;
    }
    if (!append(row)) {
      append(omittedNotice);
      break;
    }
  }
  if (library.errors.length) append('Some skill files could not be indexed. The Skills window shows the errors; do not assume this index is complete.');
  return lines.join('\n');
}
