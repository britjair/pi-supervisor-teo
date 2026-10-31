# Jira integration

Teo can use a Jira issue as the source and key of a new task.

## Interactive start

`teo new` and `/teo start` ask whether a Jira issue already exists.

- Existing issue: paste a Jira URL or key such as `APD-1253`. Teo loads its summary and description, asks for confirmation, and uses the Jira key as the Teo task key.
- No issue: enter the initial description. Teo offers to create Jira issue. If declined, it generates a `LOCAL-<id>` key.

The legacy non-interactive form remains available:

```bash
teo new APD-1253 --title "Title" --description-file requirements.md
```

## Configuration

Create `~/.pi/teo/jira.md`:

```yaml
---
schema: teo/jira-v1
baseUrl: https://company.atlassian.net
projectKey: APD
issueType: Task
auth:
  mode: basic
  tokenEnv: JIRA_TOKEN
  emailEnv: JIRA_EMAIL
---
```

For Jira Data Center with a personal access token, use `mode: bearer` and omit `emailEnv`.

Secrets are read from the process environment or `~/.env`. Do not put token values in `jira.md`:

```dotenv
JIRA_TOKEN=...
JIRA_EMAIL=user@example.com
```

Without `jira.md`, Teo uses `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE`, `JIRA_TOKEN`, and `JIRA_EMAIL` when available. Missing non-secret values are requested interactively.

## Requirements analysis

Jira description is treated as initial input, not as verified requirements. The workflow analyst must still check completeness, ambiguities, and contradictions. The example development process also instructs the analyst to update the linked Jira issue after requirements are clarified.
