import { describe, expect, it } from "vitest";

import { GitAuthEnvError } from "../../src/utils/gitAuth.js";
import { buildGitRuntimeEnv } from "../../src/utils/gitCredentialRuntime.js";

describe("gitCredentialRuntime", () => {
  it("builds https_pat env from GitCredential tokens", () => {
    const env = buildGitRuntimeEnv({
      project: { repoUrl: "https://github.com/org/repo.git", scmType: "github" },
      credential: { gitAuthMode: "https_pat", githubAccessToken: "gh_tok" },
    });

    expect(env).toEqual({
      TUIXIU_GIT_AUTH_MODE: "https_pat",
      TUIXIU_GIT_HTTP_USERNAME: "x-access-token",
      TUIXIU_GIT_HTTP_PASSWORD: "gh_tok",
      GH_TOKEN: "gh_tok",
      GITHUB_TOKEN: "gh_tok",
    });
  });

  it("builds ssh env from GitCredential ssh key", () => {
    const env = buildGitRuntimeEnv({
      project: { repoUrl: "git@gitlab.com:org/repo.git", scmType: "gitlab" },
      credential: { gitAuthMode: "ssh", gitSshKeyB64: "a2V5" },
    });

    expect(env).toEqual({
      TUIXIU_GIT_AUTH_MODE: "ssh",
      TUIXIU_GIT_SSH_KEY_B64: "a2V5",
    });
  });

  it("builds https_basic env from GitCredential username/password", () => {
    const env = buildGitRuntimeEnv({
      project: { repoUrl: "https://git.example.com/org/repo.git", scmType: "git" },
      credential: { gitAuthMode: "https_basic", gitHttpUsername: "git", gitHttpPassword: "secret" },
    });

    expect(env).toEqual({
      TUIXIU_GIT_AUTH_MODE: "https_basic",
      TUIXIU_GIT_HTTP_USERNAME: "git",
      TUIXIU_GIT_HTTP_PASSWORD: "secret",
    });
  });

  it("throws with code when https_pat token missing", () => {
    try {
      buildGitRuntimeEnv({
        project: { repoUrl: "https://github.com/org/repo.git", scmType: "github" },
        credential: { gitAuthMode: "https_pat", githubAccessToken: "" },
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GitAuthEnvError);
      expect((error as any).code).toBe("GIT_CREDENTIAL_HTTPS_TOKEN_MISSING");
    }
  });

  it("throws with code when ssh key missing", () => {
    try {
      buildGitRuntimeEnv({
        project: { repoUrl: "git@gitlab.com:org/repo.git", scmType: "gitlab" },
        credential: { gitAuthMode: "ssh" },
      });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GitAuthEnvError);
      expect((error as any).code).toBe("GIT_CREDENTIAL_SSH_AUTH_MISSING");
    }
  });
});
