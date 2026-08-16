import type { SkillDefinition } from "./types.js";

export interface SkillRegistry {
  get(name: string): SkillDefinition<unknown> | undefined;
  all(): SkillDefinition<unknown>[];
}

export function createSkillRegistry(skills: SkillDefinition<unknown>[]): SkillRegistry {
  const ordered: SkillDefinition<unknown>[] = [];
  const byName = new Map<string, SkillDefinition<unknown>>();
  for (const skill of skills) {
    if (byName.has(skill.name)) {
      throw new Error(`duplicate skill name: ${skill.name}`);
    }
    byName.set(skill.name, skill);
    ordered.push(skill);
  }
  return {
    get: (name) => byName.get(name),
    all: () => ordered.slice(),
  };
}
