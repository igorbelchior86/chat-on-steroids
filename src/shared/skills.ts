/** Where a discovered skill is owned. */
export type SkillScope = 'managed' | 'repo' | 'user' | 'system' | 'admin';

/** Concrete discovery source within a scope. */
export type SkillSource =
  | 'managed'
  | 'repo-agents'
  | 'project-codex'
  | 'user-agents'
  | 'codex-home'
  | 'bundled'
  | 'admin';

/** Optional tool dependency declared by agents/openai.yaml. */
export interface SkillDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
  oauthCallbackPort?: number;
}

/** One discovered skill exposed to the renderer/prompt composer. */
export interface SkillSummary {
  /** Legacy managed-library handle retained for existing callers. */
  id: string;
  /** Exact mutable managed folder id; absent for read-only discovered skills. */
  managedId?: string;
  /** Exact canonical SKILL.md identity. */
  key: string;
  /** Slash command including the leading slash. */
  command: string;
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  dependencies?: SkillDependency[];
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
  allowImplicitInvocation: boolean;
}

/** One root consulted for the current discovery scope. */
export interface SkillRootSummary {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
  readOnly: boolean;
}

/** Fresh on-disk projection. Per-skill failures stay visible instead of hiding entries silently. */
export interface SkillLibrary {
  /** Managed userData/skills location retained for compatibility. */
  directory: string;
  skills: SkillSummary[];
  errors: string[];
  roots?: SkillRootSummary[];
  includeInstructions?: boolean;
  /** Optional effective catalog budget from Codex skills.max_context_tokens. */
  maxContextTokens?: number;
}
