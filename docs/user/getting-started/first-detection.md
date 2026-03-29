# Your First Detection

This guide takes you from a freshly configured Sentinel instance to receiving your first real security alert. You will activate a detection from a built-in template, verify that your integration is working, and see the alert appear in the Sentinel interface.

**Goal:** By the end of this guide, you will have an active detection watching for a security event in one of your monitored domains, and you will understand what happens when an alert fires.

## Prerequisites

Before you start, complete the following steps:

- Sentinel is installed and running. See [Installation](installation.md).
- You are logged in as an admin or editor.
- You have at least one notification channel configured. See [Initial Setup](initial-setup.md).
- You have access to a data source that Sentinel can monitor (for example, a GitHub organization where you can install the Sentinel GitHub App).

---

## Step 1: Browse the Template Library

Detection templates are pre-built detection rules that you can activate and optionally customize. They encode common security monitoring best practices so you do not have to write rules from scratch.

1. In the sidebar, click **detections**.
2. On the **Detections** page, click **+ New Detection** in the top-right corner.
3. On the **New Detection** page, you see module tabs across the top: **github**, **infra**, **chain**, **registry**, and **aws**. Click a tab to see templates for that module.

Each template card shows:

- The template **name** and a short description.
- The default **severity** level (color-coded: red for critical, orange for high, green for medium, grey for low).
- The **category** (for example, `access-control`, `code-protection`).
- The number of **rules** the template creates.
- Any **required inputs** you need to provide (listed at the bottom of the card).

For modules with many templates, use the category filter below the module tabs to narrow the list. The **github** module includes categories like `access-control`, `code-protection`, `secrets`, `organization`, and `comprehensive`. The **aws** module includes `identity`, `defense-evasion`, `network`, `data`, `compute`, `reconnaissance`, and `comprehensive`. Other modules derive their categories dynamically from the available templates.

The **chain** module also provides a search bar to find templates by keyword.

## Step 2: Select a Template

For your first detection, choose a template that matches a data source you have already connected. This guide uses the **github** module as an example, but the process is the same for any module.

**Example: Repository Visibility Monitor**

This template alerts you when a repository in your GitHub organization is made public -- one of the most impactful accidental exposures a security team monitors for.

1. Make sure the **[github]** tab is selected.
2. Optionally, use the category filter to narrow the list. Click **access-control** or leave it on **all**.
3. Find the **Repository Visibility Monitor** card.
4. Click the card to select it.

## Step 3: Configure the Detection

After you select a template, a configuration form appears. Fill in the following fields:

- **Detection name** -- Pre-filled with the template name. You can change this to something specific to your environment, such as `GitHub - Public Repo Alert`.
- **Severity** -- Select from **critical**, **high**, **medium**, or **low**. The template default is shown, but you can override it by clicking the severity level you want.
- **Cooldown (minutes)** -- The minimum number of minutes between repeated alerts for this detection. The default is 5 minutes. Set to 0 for no cooldown, or increase it if you expect frequent triggers.
- **Template-specific inputs** -- Each template defines its own configuration fields. Required fields are marked with a red asterisk. For templates with conditional fields, some inputs appear only after you fill in a related field.

Input types vary by template:

- **Text and number fields** -- Type your value directly.
- **Select dropdowns** -- Choose from a predefined list (for example, network selection for chain templates).
- **Boolean toggles** -- Click **[true]** or **[false]**.
- **String arrays** -- Enter one value per line, or separate values with commas.
- **Address fields** -- Enter a blockchain address (for chain templates).
- **Contract and network selectors** -- Choose from your registered contracts and networks (for chain templates). Selecting a contract auto-fills the associated network.

> **Tip:** If a template input has a help annotation, it appears next to the label in lighter text.

## Step 4: Connect Your Integration (If Not Already Done)

Before you activate the detection, Sentinel needs permission to receive events from the data source. If you have not yet connected the relevant integration, do so now:

**For GitHub:**

1. In the sidebar, expand the **github** section and click **installations**.
2. Click **Install GitHub App**.
3. You are redirected to GitHub. Select the organization or repositories you want Sentinel to monitor.
4. Complete the installation. You are redirected back to Sentinel.

**For other modules:**

- **Chain** -- Navigate to **chain** > **contracts** and add the contract addresses you want to monitor.
- **Infrastructure** -- Navigate to **infra** > **hosts** and add the hosts you want to monitor.
- **Registry** -- Navigate to **registry** > **docker images** or **registry** > **npm packages** and add the artifacts you want to monitor.
- **AWS** -- Navigate to **aws** > **integrations** and configure your CloudTrail event source.

> **Note:** If the integration is already connected, skip this step and proceed to Step 5.

## Step 5: Activate the Detection

Return to the **New Detection** page and re-select your template if you navigated away.

1. Confirm all required fields are filled in.
2. Click **Create Detection**.

Sentinel creates the detection and sets its status to **active**. You are redirected to the detection detail page. The detection also appears in the **Detections** list (accessible from the sidebar) with a green **[active]** status indicator.

## Step 6: Trigger the Event

Now trigger the event that the detection is watching for. For the GitHub Repository Visibility Monitor example:

1. Log into GitHub.
2. Navigate to a repository in the organization where you installed Sentinel. Use a non-critical or test repository.
3. Go to the repository **Settings** > **Danger Zone**.
4. Click **Change repository visibility** and set it to **Public** (or confirm the change if prompted).

> **Important:** If you do not want to actually make a repository public, you can create a new empty private repository, make it public, and then immediately make it private again. Sentinel still receives and processes the event.

## Step 7: View the Alert

Within a few seconds to a minute (depending on webhook delivery latency), the alert appears in Sentinel.

1. Click **detections** in the sidebar to return to the **Detections** list. Your detection should now show a recent timestamp in the **Last Alert** column.
2. From the **Dashboard** (click **dashboard** in the sidebar), scroll to the **Recent Alerts** section at the bottom. Your alert appears in the feed with its severity tag, title, and timestamp.
3. Click the alert to open the detail view.

The alert record includes:

- **Severity** -- The severity level you configured, displayed as a color-coded tag (for example, `[!!]` for critical, `[!]` for high).
- **Title** -- A description of what happened (for example, `Repository made public: your-org/your-repo`).
- **Module** -- The source module (for example, `github`).
- **Detection** -- The name you gave the detection.
- **Timestamp** -- When the event occurred.
- **Notification status** -- Whether the alert was successfully dispatched to your configured channels: `[sent]`, `[pending]`, `[fail]`, `[partial]`, or `[--]` (no channels).

If you configured a Slack channel or email channel, you should also have received a notification there.

## Step 8: Test a Detection Without Triggering a Real Event

If you want to verify that a detection works without causing a real change in an external system, you can use the test endpoint via the API. Submit a synthetic event to see whether the detection would fire:

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

## Using a Template vs. a Custom Rule

Templates are the fastest way to get started. They encode proven detection logic and expose only the settings you need to customize. For your first detection, always start with a template.

As you gain experience, you may want to create custom detections with rules tailored to your environment. Custom rules give you full control over the event type, match conditions, resource filters, priority, and action. For more information, see [Custom Rules](../detections/custom-rules.md).

---

## What Happens When an Alert Fires: The Full Pipeline

Understanding the alert pipeline helps you triage effectively:

1. **The event arrives.** Sentinel receives a webhook event from GitHub (or another module) and normalizes it into a standard event record with a module ID, event type, payload, and timestamps.
2. **The detection engine evaluates it.** Every active detection rule for your organization and module is loaded, ordered by priority (lowest priority number first), and evaluated against the event. If a rule matches, an alert candidate is created.
3. **Cooldown is checked.** If the detection has a cooldown configured, Sentinel checks whether the detection fired recently. If it did, the new match is suppressed. Cooldown is enforced atomically using Redis with a database fallback.
4. **The alert is written.** Alert candidates that pass cooldown are written to the database with a `pending` notification status.
5. **Notifications are dispatched.** A background worker picks up the alert and dispatches it to every notification channel attached to the detection. The notification status is updated to `sent`, `partial`, `failed`, or `no_channels` based on the outcome. Individual delivery results are recorded for audit purposes.
6. **The correlation engine also evaluates.** Simultaneously, the event is checked against active correlation rules for your organization. If it advances or completes a correlation sequence, a correlated alert may be created in addition to the detection alert.

For more information on the full alert lifecycle, see [Alerting System](../core-concepts/alerting-system.md).

For more information on how detection rules work, see [Detection Engine](../core-concepts/detection-engine.md).
