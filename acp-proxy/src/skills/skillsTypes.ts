export type SkillsManifest = {
  runId: string;
  skillVersions: Array<{
    skillId: string;
    skillName: string;
    skillVersionId: string;
    contentHash: string;
    storageUri: string;
  }>;
};

