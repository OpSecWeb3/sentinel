# Your First Detection

This guide takes you from a freshly configured Sentinel instance to receiving your first real security alert. You will activate a detection from a built-in template, connect your GitHub organization, trigger the event manually, and then see the alert appear in the Sentinel interface.

**Goal:** By the end of this guide, you will have an active detection watching for GitHub repository visibility changes and you will have seen what an alert looks like in Sentinel.

## Prerequisites

Before you start, complete the following steps:

- Sentinel is installed and running. See [Installation](installation.md).
- You are logged in as an admin or editor.
- You have at least one notification channel configured. See [Initial Setup](initial-setup.md).
- You have access to a GitHub organization where you can install the Sentinel GitHub App.

---

## Step 1: Browse the Template Library

Detection templates are pre-built detection rules that you can activate and optionally customize. They encode common security monitoring best practices so you do not have to write rules from scratch.

1. In the sidebar, click **detections**.
2. On the **Detections** page, click **New Detection** (or navigate directly to `/detections/new`).
3. On the **New Detection** page, you will see module tabs across the top: **github**, **infra**, **chain**, **registry**, and **aws**. Click a tab to see templates for that module.

Each template card shows:

- The template name and a short description
- The default severity level (color-coded: red for critical, orange for high, green for medium, grey for low)
- The category (for example, `access-control`, `code-protection`)
- The number of rules the template creates
- Any required inputs you will need to provide

## Step 2: Select the Repository Visibility Monitor Template

For your first detection, use a template from the **github** module. The **Repository Visibility Monitor** template alerts you when a repository in your GitHub organization is made public -- one of the most impactful accidental exposures a security team monitors for.

1. Make sure the **github** tab is selected.
2. Optionally, use the category filter to narrow the list. Select **access-control** or **all**.
3. Find the **Repository Visibility Monitor** card.
4. Click the card to select it.

## Step 3: Configure the Detection

After you select a template, a configuration form appears. Fill in the following fields:

- **Detection name** -- Pre-filled with the template name. You can change this to something specific to your environment, such as `GitHub - Public Repo Alert`.
- **Severity** -- Select from **critical**, **high**, **medium**, or **low**. The template default is shown, but you can override it.
- **Cooldown (minutes)** -- The minimum number of minutes between repeated alerts for this detection. The default is 5 minutes. Set to 0 for no cooldown, or increase it if you expect frequent triggers.
- **Template-specific inputs** -- Each template defines its own configuration fields. For the Repository Visibility Monitor, this may include options like which visibility change to alert on and repositories to exclude. Fill in or accept the defaults for each field. Required fields are marked with a red asterisk.

> **Tip:** If a template input has a help tooltip, hover over the label to see additional guidance on what the field controls.

## Step 4: Connect Your GitHub Integration

Before you activate the detection, Sentinel needs permission to receive events from your GitHub organization. Sentinel uses a GitHub App installation for this.

1. In the sidebar, click **github**, then click **installations**.
2. Click **Install GitHub App**.
3. You are redirected to GitHub. Select the organization or repositories you want Sentinel to monitor.
4. Complete the GitHub App installation. You are redirected back to Sentinel.
5. Your GitHub organization now appears in the **Installations** list.

For full details on GitHub App permissions and configuration options, see [GitHub App Integration](../integrations/github-app.md).

> **Note:** If you already see your GitHub organization listed in **installations**, the integration is already connected and you can skip this step.

## Step 5: Activate the Detection

Return to the **New Detection** page (use the browser back button or navigate to `/detections/new` and re-select the template).

1. Confirm all required fields are filled in.
2. Click **Create Detection**.

Sentinel creates the detection and sets its status to **active**. You are redirected to the detection detail page. The detection also appears in the **Detections** list with a status indicator showing it is active.

## Step 6: Trigger the Event

Now trigger the event that the detection is watching for. In this case, that means changing a repository's visibility in GitHub.

1. Log into GitHub.
2. Navigate to a repository in the organization where you installed Sentinel. Use a non-critical or test repository.
3. Go to **Settings** > **Danger Zone**.
4. Click **Change repository visibility** and set it to **Public** (or confirm the change if prompted).

> **Important:** If you do not want to actually make a repository public, you can create a new empty private repository, make it public, and then immediately make it private again. Sentinel will still receive and process the event.

## Step 7: View the Alert

Within a few seconds to a minute (depending on GitHub webhook delivery latency), the alert appears in Sentinel.

1. Click **detections** in the sidebar to return to the **Detections** list. Your detection should now show a **Last Triggered** timestamp.
2. Navigate to the alerts view to see all alerts across all detections.

The alert record includes:

- **Title** -- A description of what happened (for example, `Repository made public: your-org/your-repo`).
- **Severity** -- The severity you configured (for example, `critical`).
- **Module** -- `github`.
- **Detection** -- The name you gave the detection.
- **Timestamp** -- When the event occurred.
- **Description** -- Details about the repository and who made the change.
- **Notification status** -- Whether the alert was successfully dispatched to your configured channels.

If you configured a Slack channel or email channel, you should also have received a notification there.

## Step 8: Test a Detection Without Triggering a Real Event

If you want to verify that a detection works without causing a real change in GitHub, you can use the **test** endpoint. From the detection detail page or via the API, you can submit a synthetic event to see whether the detection would fire:

```
POST /api/detections/<detection-id>/test
Content-Type: application/json

{
  "event": {
    "eventType": "repository.publicized",
    "payload": {
      "repository": { "full_name": "your-org/test-repo" },
      "sender": { "login": "your-username" }
    }
  }
}
```

The response tells you whether the detection would trigger (`wouldTrigger: true` or `false`), how many rules were evaluated, and whether any suppress rules fired. No actual alert is created during a test.

---

## What Happens Next: The Alert Pipeline

Understanding what happens after an event arrives helps you triage effectively:

1. **The event arrives.** Sentinel receives a webhook event from GitHub (or another module) and normalizes it into a standard event record.
2. **The detection engine evaluates it.** Every active detection rule for your organization and module is loaded, ordered by priority (lowest priority number first), and evaluated against the event. If a rule matches, an alert candidate is created.
3. **Cooldown is checked.** If the detection has a cooldown configured, Sentinel checks whether the detection fired recently. If it did, the new match is suppressed. Cooldown is enforced atomically using Redis with a database fallback.
4. **The alert is written.** Alert candidates that pass cooldown are written to the database with a `pending` notification status.
5. **Notifications are dispatched.** A background worker picks up the alert and dispatches it to every notification channel attached to the detection. The notification status is updated to `sent`, `partial`, `failed`, or `no_channels` based on the outcome. Individual delivery results are recorded for audit purposes.
6. **The correlation engine also evaluates.** Simultaneously, the event is checked against active correlation rules for your organization. If it advances or completes a correlation sequence, a correlated alert may be created in addition to the detection alert.

For more information on the full alert lifecycle, see [Alerting System](../core-concepts/alerting-system.md).

For more information on how detection rules work, see [Detection Engine](../core-concepts/detection-engine.md).
