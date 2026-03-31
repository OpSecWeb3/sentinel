import type { EventTypeDefinition } from '@sentinel/shared/module';

export const eventTypes: EventTypeDefinition[] = [
  {
    type: 'github.repository.visibility_changed',
    label: 'Repository visibility changed',
    description: 'A repository was made public or private',
  },
  {
    type: 'github.repository.created',
    label: 'Repository created',
    description: 'A new repository was created in the organization',
  },
  {
    type: 'github.repository.deleted',
    label: 'Repository deleted',
    description: 'A repository was deleted from the organization',
  },
  {
    type: 'github.repository.archived',
    label: 'Repository archived',
    description: 'A repository was archived',
  },
  {
    type: 'github.repository.unarchived',
    label: 'Repository unarchived',
    description: 'A repository was unarchived',
  },
  {
    type: 'github.repository.transferred',
    label: 'Repository transferred',
    description: 'A repository was transferred to another owner',
  },
  {
    type: 'github.repository.renamed',
    label: 'Repository renamed',
    description: 'A repository was renamed',
  },
  {
    type: 'github.member.added',
    label: 'Member added',
    description: 'A collaborator was added to a repository or organization',
  },
  {
    type: 'github.member.removed',
    label: 'Member removed',
    description: 'A collaborator was removed from a repository or organization',
  },
  {
    type: 'github.organization.member_added',
    label: 'Organization member added',
    description: 'A user was added to the organization',
  },
  {
    type: 'github.organization.member_removed',
    label: 'Organization member removed',
    description: 'A user was removed from the organization',
  },
  {
    type: 'github.team.created',
    label: 'Team created',
    description: 'A new team was created in the organization',
  },
  {
    type: 'github.team.deleted',
    label: 'Team deleted',
    description: 'A team was deleted from the organization',
  },
  {
    type: 'github.branch_protection.created',
    label: 'Branch protection created',
    description: 'A branch protection rule was created',
  },
  {
    type: 'github.branch_protection.edited',
    label: 'Branch protection modified',
    description: 'A branch protection rule was modified',
  },
  {
    type: 'github.branch_protection.deleted',
    label: 'Branch protection deleted',
    description: 'A branch protection rule was removed',
  },
  {
    type: 'github.branch_protection_configuration.disabled',
    label: 'Branch protection disabled (repo-wide)',
    description: 'All branch protection was disabled for the repository',
  },
  {
    type: 'github.branch_protection_configuration.enabled',
    label: 'Branch protection enabled (repo-wide)',
    description: 'Branch protection was enabled for the repository',
  },
  {
    type: 'github.deploy_key.created',
    label: 'Deploy key added',
    description: 'A deploy key was added to a repository',
  },
  {
    type: 'github.deploy_key.deleted',
    label: 'Deploy key removed',
    description: 'A deploy key was removed from a repository',
  },
  {
    type: 'github.secret_scanning.created',
    label: 'Secret scanning alert created',
    description: 'A new secret scanning alert was created',
  },
  {
    type: 'github.secret_scanning.publicly_leaked',
    label: 'Secret scanning — publicly leaked',
    description: 'A secret was detected as publicly leaked',
  },
  {
    type: 'github.secret_scanning.assigned',
    label: 'Secret scanning alert assigned',
    description: 'A secret scanning alert was assigned to a user',
  },
  {
    type: 'github.secret_scanning.unassigned',
    label: 'Secret scanning alert unassigned',
    description: 'Assignee removed from a secret scanning alert',
  },
  {
    type: 'github.secret_scanning.validated',
    label: 'Secret scanning alert validated',
    description: 'A secret scanning alert was validated',
  },
  {
    type: 'github.push',
    label: 'Push event',
    description: 'Code was pushed to a repository',
  },
  {
    type: 'github.secret_scanning.resolved',
    label: 'Secret scanning alert resolved',
    description: 'A secret scanning alert was resolved',
  },
  {
    type: 'github.member.edited',
    label: 'Member edited',
    description: 'A collaborator permission was changed',
  },
  {
    type: 'github.team.edited',
    label: 'Team edited',
    description: 'A team was modified',
  },
  {
    type: 'github.team.added_to_repository',
    label: 'Team added to repository',
    description: 'A team was given access to a repository',
  },
  {
    type: 'github.team.removed_from_repository',
    label: 'Team removed from repository',
    description: 'A team was removed from a repository',
  },
  {
    type: 'github.organization.member_invited',
    label: 'Organization member invited',
    description: 'A user was invited to the organization',
  },
  {
    type: 'github.installation.deleted',
    label: 'Installation deleted',
    description: 'The GitHub App installation was removed',
  },
  {
    type: 'github.installation.suspended',
    label: 'Installation suspended',
    description: 'The GitHub App installation was suspended',
  },
  {
    type: 'github.installation.unsuspended',
    label: 'Installation unsuspended',
    description: 'The GitHub App installation was reactivated',
  },
  {
    type: 'github.installation.created',
    label: 'Installation created',
    description: 'A new GitHub App installation was created',
  },
];
