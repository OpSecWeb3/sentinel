# User management

This page describes how to manage team members, roles, and access control in your Sentinel organization.

## Prerequisites

You must have the **admin** role to perform most actions on this page. The specific role requirements for each action are noted below.

---

## User roles

Sentinel uses three roles to control access. Users are assigned a role when they join an organization. Role changes take effect immediately -- the affected user's active sessions are invalidated and they must log in again.

### Role capabilities

| Action | Admin | Editor | Viewer |
|---|---|---|---|
| View alerts and events | Yes | Yes | Yes |
| View detections | Yes | Yes | Yes |
| Create and edit detections | Yes | Yes | No |
| Delete detections | Yes | Yes | No |
| Manage notification channels | Yes | Yes | No |
| View API keys | Yes | Yes | Yes |
| Create and revoke API keys | Yes | Yes | No |
| View organization members | Yes | No | No |
| Invite members (manage invite secret) | Yes | No | No |
| Change member roles | Yes | No | No |
| Remove members | Yes | No | No |
| Access organization settings (admin tabs) | Yes | No | No |
| Connect Slack | Yes | Yes | No |
| Disconnect Slack | Yes | No | No |
| Manage notify key | Yes | No | No |
| Manage webhook secret | Yes | No | No |
| Add/remove monitored artifacts | Yes | Yes | No |
| Manage GitHub App installations | Yes | Yes | No |
| Manage AWS integrations | Yes | Yes | No |
| Update monitored artifact configuration | Yes | Yes | No |
| View audit log | Yes | No | No |
| Delete organization | Yes | No | No |

---

## Inviting team members

Sentinel uses an invite secret to control who can join your organization. There is no email-based invitation flow. You share the invite secret through a secure channel of your choice.

### Retrieve the current invite secret

1. In **Settings**, select the **Invite** tab.
2. Click **Show invite secret**.

The raw invite secret is displayed. Copy it and share it securely with the person you want to invite.

> **Important:** The invite secret grants access to your organization to anyone who holds it. Treat it like a password. After you have invited all intended users, rotate the secret.

The invite secret is stored as a one-way hash for verification and also in an encrypted form that only admins can retrieve. This dual storage allows Sentinel to verify incoming secrets without storing plaintext, while still permitting admins to view the current secret.

### How a new user joins

The person you are inviting must:

1. Navigate to the Sentinel registration page.
2. Complete the registration form with a username (3-50 characters, alphanumeric plus hyphens and underscores), email address, and password (minimum 8 characters, maximum 128 characters).
3. Enter the invite secret in the **Invite secret** field.

When they submit the form, Sentinel verifies the secret against the stored hash. If it matches, the account is created and the user joins the organization with the **viewer** role.

### First user setup

The first user to register creates both their account and the organization simultaneously. This user must provide an **Organization name** field during registration. The first user is automatically assigned the **admin** role and receives the initial invite secret, which is displayed once during registration.

### Joining an existing organization (after registration)

If a user already has an account but no organization membership, they can join an organization by:

1. Navigating to their account settings.
2. Providing the invite secret for the target organization.

The user joins with the **viewer** role. Their session is refreshed immediately to reflect the new organization membership.

### Rotating the invite secret

If the invite secret is exposed or you want to prevent further registrations:

1. In **Settings**, select the **Invite** tab.
2. Click **Regenerate invite secret**.

The previous secret is immediately invalidated. Existing members are not affected. The new secret is displayed once -- copy it before closing the dialog.

---

## Changing user roles

You can change a member's role at any time. Role changes take effect immediately.

1. In **Settings**, select the **Members** tab.
2. Find the user whose role you want to change.
3. In the **Role** column, select the new role: **admin**, **editor**, or **viewer**.
4. Confirm the change.

When a role change is applied:

- All active sessions for the target user are invalidated. The user must log in again to receive the new role.
- This prevents stale role data from persisting in encrypted session cookies.

**Constraints:**

- You cannot change your own role.
- You cannot demote the last admin in the organization. Promote another member to admin first.

---

## Removing users

To remove a member from the organization:

1. In **Settings**, select the **Members** tab.
2. Find the user you want to remove.
3. Click **Remove** next to their name.
4. Confirm the removal.

When a member is removed:

- Their organization membership is deleted immediately.
- All API keys they held for this organization are automatically revoked.
- All active sessions for the user are invalidated; they are signed out immediately.

You cannot remove yourself using this flow. To leave the organization, use the **Leave Organization** option in your account settings. When leaving:

- If you are the last admin, the operation is rejected. Promote another member to admin first.
- All your API keys for the organization are revoked.
- All your sessions are invalidated.

---

## Login security

### Account lockout after failed attempts

Sentinel implements brute-force protection on the login endpoint:

- After **5 consecutive failed login attempts**, the account is locked for **15 minutes**.
- During the lockout period, login attempts return a `423 Locked` response regardless of whether the password is correct.
- A successful login resets the failed attempt counter to zero.
- Changing your password also resets the counter and clears any active lockout.

### Timing-safe login responses

Sentinel uses constant-time comparison for login responses to prevent user enumeration. When a login attempt is made with a username that does not exist, Sentinel still performs an argon2id verification against a dummy hash. This ensures that the response time is the same whether or not the username exists, preventing attackers from using timing differences to determine valid usernames.

### Session management

- When a user logs in, any pre-existing session is destroyed to prevent session fixation attacks.
- When a user changes their password, all sessions except the current one are invalidated.
- Sessions are encrypted and stored server-side. Session data (user ID, organization ID, role) cannot be extracted via database queries.

---

## Changing your password

1. In your account settings, select **Change Password**.
2. Enter your current password.
3. Enter and confirm your new password (minimum 8 characters).
4. Click **Save**.

After changing your password:

- The failed login attempt counter is reset.
- Any active lockout is cleared.
- All sessions except your current session are invalidated, signing you out of other browsers and devices.

---

## Security best practices

**Apply the principle of least privilege.** Assign users the lowest role that allows them to do their job. Most users require only the **viewer** role. Reserve **admin** for team leads or security operations managers.

**Rotate the invite secret after onboarding.** Once you have finished inviting the initial team, rotate the invite secret to prevent unauthorized registrations.

**Maintain at least two admins.** Ensure your organization always has at least two users with the admin role. This prevents lockout if one admin loses access.

**Monitor the audit log.** Review `member.role_changed` and `member.removed` entries periodically to verify that access changes were authorized.
