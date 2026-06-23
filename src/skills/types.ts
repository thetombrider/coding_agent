export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  /** Absolute path to SKILL.md */
  path: string;
  /** Parent directory containing SKILL.md */
  dir: string;
}

export interface SkillContent extends SkillMeta {
  /** Markdown body after the YAML frontmatter */
  instructions: string;
}
