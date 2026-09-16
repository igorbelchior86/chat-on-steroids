import { listSkills, readSkill, type SkillScopeOptions } from '../skills.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';

const COMMAND_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function normalizedSkillCommand(token: string): string {
  const value = token.startsWith('/') ? token.slice(1) : token;
  if (!COMMAND_TOKEN.test(value)) throw new Error('Choose a valid installed skill command.');
  return `/${value}`;
}

/** Slash commands are recognized only in the leading command block, never in task prose. */
export function leadingSkillIds(text: string): string[] {
  const commands = new Set<string>();
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const explicit = /^\/prompt(?:[ \t]+([^\s]+))?[ \t]*$/.exec(line);
    if (explicit) {
      if (!explicit[1]) throw new Error('Choose a skill after /prompt before sending.');
      try { commands.add(normalizedSkillCommand(explicit[1])); }
      catch { throw new Error('Choose a valid skill command after /prompt.'); }
      continue;
    }
    const direct = /^\/([a-z0-9][a-z0-9._-]{0,63})[ \t]*$/.exec(line);
    if (!direct) break;
    commands.add(normalizedSkillCommand(direct[1]!));
  }
  return [...commands];
}

/** Bodies remain complete. The existing delivery ledger freezes the returned text. */
export async function selectedSkillInstructions(
  authored: readonly string[],
  scope: SkillScopeOptions = {},
): Promise<string> {
  const commands = [...new Set(authored.flatMap(leadingSkillIds))];
  if (!commands.length) return '';
  const library = await listSkills(scope);
  const available = new Map(library.skills.map(skill => [skill.command, skill]));
  const lines = ['# Selected skills', 'Use these user-selected skill instructions for the task, subject to the main instructions and available tools.'];
  for (const command of commands) {
    const selected = available.get(command);
    if (!selected) throw new Error(`Skill ${command} is unavailable. Select an available skill from Skills or remove the command.`);
    const skill = await readSkill(selected.key, { ...scope, by: 'key' });
    lines.push(
      `## ${command.slice(1)}\nCommand: ${command}\nSkill: ${JSON.stringify(skill.name)}\nScope: ${skill.scope} (${skill.source})` +
      `\n\n<SKILL_INSTRUCTIONS>\n${skill.text.replace(/\r\n?/g, '\n')}\n</SKILL_INSTRUCTIONS>`
    );
    if (lines.join('\n\n').length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('Selected skills exceed the 96,000-character message limit. Select fewer or shorter skills.');
  }
  return lines.join('\n\n');
}
