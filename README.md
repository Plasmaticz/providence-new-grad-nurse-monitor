# Providence New-Grad Nurse Job Monitor

[![Providence job monitor status](https://github.com/Plasmaticz/providence-new-grad-nurse-monitor/actions/workflows/check-jobs.yml/badge.svg)](https://github.com/Plasmaticz/providence-new-grad-nurse-monitor/actions/workflows/check-jobs.yml)

**Live schedule:** Every five minutes

This repository checks Providence's official **RN Resident & Graduate** campaign every five minutes. It tracks `RN Resident` and `Graduate Nurse` openings and creates a GitHub Issue only when a new job ID appears.

The monitor runs entirely on GitHub Actions. Your computer does not need to be on, and no email password or paid email service is required.

## Set up

1. Create a **public** GitHub repository. Public repositories can use standard GitHub-hosted Actions runners without consuming private-repository minutes.
2. Push these files to the repository's default branch.
3. In **Settings > Actions > General > Workflow permissions**, select **Read and write permissions**, then save.
4. Open the **Actions** tab, select **Check Providence new-grad nurse jobs**, choose **Run workflow**, and leave **Send an issue for all current jobs** unchecked. This creates a quiet baseline so existing postings do not trigger old alerts.
5. Have each person who wants email alerts open the repository, select **Watch > Custom**, enable **Issues**, and confirm that GitHub email notifications are enabled in their account settings.

After that, a new matching posting creates an Issue containing its title, location, posting date, requisition number, and direct application link. GitHub emails the Issue notification to repository watchers for free.

To test notifications immediately, reset `data/seen_jobs.json` to its original uninitialized state, run the workflow manually, and enable **Send an issue for all current jobs**.

## Run locally

Node.js 20 or newer is the only requirement.

```bash
npm test
npm run check
```

The checker calls Providence's public Jobsyn endpoint with the same campaign used by [Providence's RN Resident & Graduate search](https://providence.jobs/campaigns/rn-resident-graduate/jobs/). The original narrower [RN Resident page](https://providence.jobs/campaigns/rn-resident/jobs/) is included by that campaign.

## Free-tier notes

- GitHub supports scheduled workflows as often as every five minutes, but scheduled runs can occasionally be delayed during high load.
- Use a public repository for this frequency. A private repository would start about 8,640 workflow jobs in a 30-day month and is likely to exceed the 2,000 included monthly minutes on GitHub Free.
- GitHub may disable scheduled workflows in a public repository after 60 days with no repository activity. Re-enable the workflow from the Actions tab if GitHub sends that inactivity notice.
